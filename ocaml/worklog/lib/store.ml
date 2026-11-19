(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type loaded = {
  world : Model.world;
  events : Event.t list;
  warnings : string list;
}

let digits s = s <> "" && String.for_all (fun c -> c >= '0' && c <= '9') s

let parse_event_file_name name =
  let suffix = ".jsonl" in
  let n = String.length name and k = String.length suffix in
  if n <= k || String.sub name (n - k) k <> suffix then None
  else
    let stem = String.sub name 0 (n - k) in
    match String.index_opt stem '.' with
    | Some 7 ->
        let month = String.sub stem 0 7 and host = String.sub stem 8 (String.length stem - 8) in
        let month_ok =
          digits (String.sub month 0 4) && month.[4] = '-' && digits (String.sub month 5 2)
        in
        let host_ok =
          host <> ""
          && String.for_all
               (fun c -> (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c = '-')
               host
        in
        if month_ok && host_ok then Some (month, host) else None
    | _ -> None

let read_file = Safefs.read_file

let lines_of blob =
  let lines = String.split_on_char '\n' blob in
  match List.rev lines with "" :: rest -> List.rev rest | _ -> lines

let event_files ctx =
  let dir = Ctx.events_dir ctx in
  List.filter
    (fun f -> Filename.check_suffix f ".jsonl" && Safefs.is_regular_file (Filename.concat dir f))
    (Safefs.list_dir dir)

let read_events ctx =
  let warnings = ref [] and events = ref [] in
  let warn m = warnings := m :: !warnings in
  let seen = Hashtbl.create 1024 in
  let horizon = ctx.Ctx.now () + Tstamp.seconds_per_day in
  let read_line host file lineno raw =
    match Event.classify raw with
    | Error why -> warn (Printf.sprintf "%s:%d: skipped malformed line (%s)" file lineno why)
    | Ok (data, ts) ->
        let other = Hashtbl.find_opt seen raw in
        if other <> None && other <> Some file then ()
        else begin
          if other = None then Hashtbl.add seen raw file;
          if ts > horizon then warn (Printf.sprintf "%s:%d: ts is more than 1 day in the future" file lineno);
          let str key = match List.assoc_opt key (List.rev data) with Some (`String s) -> s | _ -> "" in
          events :=
            { Event.ts; task = str "task"; typ = str "type"; data; host; file; line = lineno }
            :: !events
        end
  in
  List.iter
    (fun file ->
      match parse_event_file_name file with
      | None -> warn ("ignoring event file with unexpected name: " ^ file)
      | Some (_, host) -> (
          match Safefs.read_file_result (Filename.concat (Ctx.events_dir ctx) file) with
          | Error why -> warn (Printf.sprintf "cannot read %s: %s" file why)
          | Ok blob -> List.iteri (fun i raw -> read_line host file (i + 1) raw) (lines_of blob)))
    (event_files ctx);
  (List.stable_sort Event.compare (List.rev !events), List.rev !warnings)

let scan_malformed ctx =
  List.concat_map
    (fun file ->
      match parse_event_file_name file with
      | None -> [ file ^ ": unexpected event file name (ignored by readers)" ]
      | Some _ ->
          match Safefs.read_file_result (Filename.concat (Ctx.events_dir ctx) file) with
          | Error why -> [ Printf.sprintf "%s: cannot read: %s" file why ]
          | Ok blob ->
              List.concat
                (List.mapi
                   (fun i raw ->
                     match Event.classify raw with
                     | Ok _ -> []
                     | Error why -> [ Printf.sprintf "%s:%d: %s" file (i + 1) why ])
                   (lines_of blob)))
    (event_files ctx)

let hex_of_file_name name =
  (* "T-7f3a-slug.md" or "T-7f3a.md" -> "7f3a" *)
  let n = String.length name in
  if n > 6 && String.sub name 0 2 = "T-" && Filename.check_suffix name ".md" then begin
    let stem = String.sub name 2 (n - 5) in
    let hex =
      match String.index_opt stem '-' with Some i -> String.sub stem 0 i | None -> stem
    in
    if hex <> "" && String.for_all (fun c -> (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) hex
    then Some hex
    else None
  end
  else None

let product_dirs ctx =
  let dir = Ctx.tasks_dir ctx in
  List.filter (fun p -> Safefs.is_real_dir (Filename.concat dir p)) (Safefs.list_dir dir)

(* (product, hex, path) of every task-file name, regular file or not. *)
let task_entries ctx =
  List.concat_map
    (fun product ->
      let dir = Filename.concat (Ctx.tasks_dir ctx) product in
      List.filter_map
        (fun f -> Option.map (fun hex -> (product, hex, Filename.concat dir f)) (hex_of_file_name f))
        (Safefs.list_dir dir))
    (product_dirs ctx)

let task_files ctx =
  List.filter (fun (_, _, path) -> Safefs.is_regular_file path) (task_entries ctx)

(* Names of task files count for id allocation even when they are refused. *)
let task_file_hex_ids ctx = List.map (fun (_, hex, _) -> hex) (task_entries ctx)

let refused label =
  Printf.sprintf "%s is not a regular file or real directory (symbolic link?); ignored" label

(* Warnings for entries the readers skip because they are links or special files. *)
let refusals ctx =
  let events = Ctx.events_dir ctx and tasks = Ctx.tasks_dir ctx in
  let bad_dir label dir =
    match Safefs.kind dir with Some Unix.S_DIR | None -> [] | Some _ -> [ refused label ]
  in
  let event_entries =
    List.filter_map
      (fun f ->
        if Filename.check_suffix f ".jsonl" && not (Safefs.is_regular_file (Filename.concat events f))
        then Some (refused ("events/" ^ f))
        else None)
      (Safefs.list_dir events)
  in
  let task_dirs =
    List.filter_map
      (fun p ->
        if Safefs.kind (Filename.concat tasks p) = Some Unix.S_LNK then Some (refused ("tasks/" ^ p))
        else None)
      (Safefs.list_dir tasks)
  in
  let task_files_bad =
    List.filter_map
      (fun (product, _, path) ->
        if Safefs.is_regular_file path then None
        else Some (refused (Printf.sprintf "tasks/%s/%s" product (Filename.basename path))))
      (task_entries ctx)
  in
  bad_dir "events" events @ bad_dir "tasks" tasks @ event_entries @ task_dirs @ task_files_bad

let find_task_file ctx ~product ~id =
  List.find_map
    (fun (p, hex, path) -> if p = product && "T-" ^ hex = id then Some path else None)
    (task_files ctx)

let unquote v =
  let n = String.length v in
  if n >= 2 && (v.[0] = '"' || v.[0] = '\'') && v.[n - 1] = v.[0] then String.sub v 1 (n - 2) else v

let read_task_file path =
  let text = read_file path in
  let lines = String.split_on_char '\n' text in
  match lines with
  | first :: rest when String.trim first = "---" ->
      let rec go acc = function
        | [] -> None
        | l :: tl when String.trim l = "---" -> Some (List.rev acc, String.concat "\n" tl)
        | l :: tl -> (
            match String.index_opt l ':' with
            | Some i ->
                let key = String.trim (String.sub l 0 i)
                and v = String.trim (String.sub l (i + 1) (String.length l - i - 1)) in
                go ((key, unquote v) :: acc) tl
            | None -> go acc tl)
      in
      (match go [] rest with Some r -> r | None -> ([], text))
  | _ -> ([], text)

let yaml_words = [ "y"; "n"; "yes"; "no"; "on"; "off"; "true"; "false"; "null" ]

let frontmatter_scalar v =
  let plain =
    v <> ""
    && ((v.[0] >= 'A' && v.[0] <= 'Z') || (v.[0] >= 'a' && v.[0] <= 'z'))
    && String.for_all
         (fun c ->
           (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
           || c = '_' || c = '.' || c = '-')
         v
    && not (List.mem (String.lowercase_ascii v) yaml_words)
  in
  if plain then v else Yojson.Safe.to_string (`String v)

let render_task_file ~id ~product ~category ~created ~notes =
  let body =
    let n = ref (String.length notes) in
    while !n > 0 && notes.[!n - 1] = '\n' do decr n done;
    String.sub notes 0 !n
  in
  let head =
    Printf.sprintf "---\nid: %s\nproject: %s\ncategory: %s\ncreated: %s\n---\n" id
      (frontmatter_scalar product) (frontmatter_scalar category)
      (Yojson.Safe.to_string (`String created))
  in
  head ^ if body = "" then "" else body ^ "\n"

let load ctx =
  let events, warnings = read_events ctx in
  let fold_warnings = ref [] in
  let world = Fold.fold events (fun m -> fold_warnings := m :: !fold_warnings) in
  let orphans =
    List.filter_map
      (fun (product, hex, _) ->
        if Model.Smap.mem ("T-" ^ hex) world.Model.tasks then None
        else
          Some
            (Printf.sprintf "task file tasks/%s/T-%s*.md has no created event; ignored" product hex))
      (task_files ctx)
  in
  { world; events; warnings = warnings @ List.rev !fold_warnings @ orphans @ refusals ctx }
