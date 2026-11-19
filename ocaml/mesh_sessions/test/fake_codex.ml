(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module U = Yojson.Safe.Util

type spec = Yojson.Safe.t

type process = {
  pid : int;
  ppid : int;
  sid : int;
  comm : string;
  start : float;
  argv : string list;
  cwd : string option;
  files : ((int * string) list, Mesh_platform.error) result;
  zombie : bool;
}

type built = { platform : Mesh_pty_processes.platform; home : string; root : string; labels : (string * int) list }

let load path = Yojson.Safe.from_file path
let btime spec = U.to_number (U.member "btime" spec)
let names spec = List.map (fun s -> U.to_string (U.member "name" s)) (U.to_list (U.member "scenarios" spec))
let day_default = "2026/11/19"

let replace_all ~sub ~by text =
  let length = String.length sub and buffer = Buffer.create (String.length text) in
  let rec walk index =
    if index > String.length text - length then Buffer.add_string buffer (String.sub text index (String.length text - index))
    else if String.sub text index length = sub then (Buffer.add_string buffer by; walk (index + length))
    else (Buffer.add_char buffer text.[index]; walk (index + 1))
  in
  walk 0;
  Buffer.contents buffer

(* $A_UPPER before $A: the longest names first; then $W. *)
let expand spec ~work text =
  let ids = U.to_assoc (U.member "ids" spec) in
  let ids = List.sort (fun (a, _) (b, _) -> compare (String.length b) (String.length a)) ids in
  let text = List.fold_left (fun text (name, id) -> replace_all ~sub:name ~by:(U.to_string id) text) text ids in
  replace_all ~sub:"$W" ~by:work text

let of_hex hex = String.init (String.length hex / 2) (fun i -> Char.chr (int_of_string ("0x" ^ String.sub hex (2 * i) 2)))

let rec mkdir_p directory =
  if not (Sys.file_exists directory) then (mkdir_p (Filename.dirname directory); Unix.mkdir directory 0o700)

let write_rollout ~home ?(day = day_default) ~name ~mtime contents =
  let path = String.concat "/" [ home; ".codex/sessions"; day; "rollout-" ^ name ^ ".jsonl" ] in
  mkdir_p (Filename.dirname path);
  Out_channel.with_open_bin path (fun channel -> Out_channel.output_string channel contents);
  Unix.utimes path mtime mtime;
  path

let meta ~id ~cwd ~source =
  Yojson.Safe.to_string (`Assoc [ ("type", `String "session_meta"); ("payload", `Assoc [ ("id", id); ("cwd", cwd); ("source", source) ]) ])
  ^ "\n"

let header ~id ~cwd = meta ~id:(`String id) ~cwd:(`String cwd) ~source:(`String "cli")

let line spec ~work = function
  | `String text -> text ^ "\n"
  | `Assoc [ ("hex", `String hex) ] -> of_hex hex ^ "\n"
  | item -> expand spec ~work (Yojson.Safe.to_string item) ^ "\n"

let rollout_path ~home rollout =
  let day = Option.value ~default:day_default (U.to_string_option (U.member "day" rollout)) in
  String.concat "/" [ home; ".codex/sessions"; day; "rollout-" ^ U.to_string (U.member "name" rollout) ^ ".jsonl" ]

let write_rollouts spec scenario ~home ~work ~now =
  let days = ref [] in
  List.iter
    (fun rollout ->
      let day = Option.value ~default:day_default (U.to_string_option (U.member "day" rollout)) in
      days := day :: !days;
      let id = match U.member "id" rollout with `String id -> `String (expand spec ~work id) | _ -> `Null in
      let cwd = `String (expand spec ~work (U.to_string (U.member "cwd" rollout))) in
      let source = match U.member "source" rollout with `Null -> `String "cli" | source -> source in
      let lines = match U.member "lines" rollout with `List items -> items | _ -> [] in
      let contents = meta ~id ~cwd ~source ^ String.concat "" (List.map (line spec ~work) lines) in
      let mtime = now -. U.to_number (U.member "age" rollout) in
      ignore (write_rollout ~home ~day ~name:(U.to_string (U.member "name" rollout)) ~mtime contents))
    (U.to_list (U.member "rollouts" scenario));
  List.iter
    (fun day ->
      let age = match U.member "days" scenario with `Assoc days -> List.assoc_opt day days | _ -> None in
      let age = match age with Some age -> U.to_number age | None -> 0. in
      Unix.utimes (String.concat "/" [ home; ".codex/sessions"; day ]) (now -. age) (now -. age))
    (List.sort_uniq compare !days)

let words spec ~work = function
  | `Assoc [ ("hex", `String hex) ] -> [ of_hex hex ]
  | `String "$TAIL" -> List.map U.to_string (U.to_list (U.member "tail" spec))
  | word -> [ expand spec ~work (U.to_string word) ]

let files spec scenario ~home ~work entry =
  match U.to_string_option (U.member "fd_state" entry) with
  | Some "unreadable" -> Error (Mesh_platform.Malformed "fd")
  | Some "vanished" -> Error Mesh_platform.Not_found
  | _ ->
      let rollouts = U.to_list (U.member "rollouts" scenario) in
      let target name =
        match List.find_opt (fun r -> U.member "name" r = `String name) rollouts with
        | Some rollout -> rollout_path ~home rollout
        | None -> expand spec ~work name
      in
      let fds = match U.member "fds" entry with `List fds -> List.map U.to_string fds | _ -> [] in
      Ok (List.mapi (fun index name -> (index + 3, target name)) fds)

let base = {|[{"pid": 1, "comm": "systemd", "ppid": 0, "age": -1, "cwd": "/", "argv": ["/sbin/init"]},
  {"pid": 50, "comm": "bash", "ppid": 1, "age": 9000, "cwd": "$W", "argv": ["bash"]},
  {"pid": 60, "comm": "bash", "ppid": 1, "age": 9000, "cwd": "/", "argv": ["bash"]}]|}

let process_of spec scenario ~home ~work ~now entry =
  let age = U.to_number (U.member "age" entry) in
  {
    pid = U.to_int (U.member "pid" entry);
    ppid = U.to_int (U.member "ppid" entry);
    sid = 0;
    comm = U.to_string (U.member "comm" entry);
    start = (if age < 0. then btime spec else now -. age);
    argv = List.concat_map (words spec ~work) (U.to_list (U.member "argv" entry));
    cwd = Option.map (expand spec ~work) (U.to_string_option (U.member "cwd" entry));
    files = files spec scenario ~home ~work entry;
    zombie = U.member "zombie" entry = `Bool true;
  }

(* A helper is in its parent Codex's session, as in a terminal; others lead their own. *)
let with_sessions processes =
  let find pid = List.find_opt (fun p -> p.pid = pid) processes in
  let rec sid p = match find p.ppid with Some parent when parent.comm = "codex" -> sid parent | _ -> p.pid in
  List.map (fun p -> { p with sid = sid p }) processes

let to_platform ~btime p : Mesh_platform.process =
  {
    pid = p.pid;
    ppid = p.ppid;
    pgrp = p.sid;
    sid = p.sid;
    tpgid = -1;
    comm = p.comm;
    state = (if p.zombie then 'Z' else 'S');
    incarnation = Int64.of_float ((p.start -. btime) *. 100.);
  }

let platform ~btime processes : Mesh_pty_processes.platform =
  let sorted = List.sort (fun a b -> compare a.pid b.pid) processes in
  let lookup f pid = match List.find_opt (fun p -> p.pid = pid) sorted with Some p -> f p | None -> Error Mesh_platform.Not_found in
  {
    scan = (fun () -> Ok { Mesh_platform.processes = List.map (to_platform ~btime) sorted; skipped = 0 });
    process = lookup (fun p -> Ok (to_platform ~btime p));
    command_line = lookup (fun p -> Ok p.argv);
    working_directory = lookup (fun p -> Option.to_result ~none:Mesh_platform.Not_found p.cwd);
    open_file_paths = lookup (fun p -> p.files);
  }

let build spec name ~root ~now =
  let scenario = List.find (fun s -> U.member "name" s = `String name) (U.to_list (U.member "scenarios" spec)) in
  let home = Filename.concat root "home" and work = Filename.concat root "w" in
  mkdir_p (Filename.concat work "sub");
  mkdir_p home;
  write_rollouts spec scenario ~home ~work ~now;
  let entries = U.to_list (Yojson.Safe.from_string base) @ U.to_list (U.member "processes" scenario) in
  let processes = with_sessions (List.map (process_of spec scenario ~home ~work ~now) entries) in
  let labels = List.map (fun (label, pid) -> (label, U.to_int pid)) (U.to_assoc (U.member "labels" scenario)) in
  { platform = platform ~btime:(btime spec) processes; home; root; labels }

let session pid = { Mesh_agent.name = Printf.sprintf "s%d" pid; created = 1.5; pid }

let describe adapter round pid =
  Mesh_agent_codex.describe adapter round (session pid) (Option.get (Mesh_agent_round.find round pid))

let config ~btime ~now =
  { Mesh_agent_codex.now = (fun () -> now); boot_time = (fun () -> Some btime); registry_lookup = (fun _ -> None) }
