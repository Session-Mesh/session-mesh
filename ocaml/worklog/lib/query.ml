(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Model

type task_filter = {
  product : string option;
  project : string option;
  status : string list;
  include_closed : bool;
  track : string option;
  owner : string option;
  session : string option;
  category : string option;
}

let no_filter =
  {
    product = None; project = None; status = []; include_closed = false;
    track = None; owner = None; session = None; category = None;
  }

let product_scope ?taxonomy product =
  match taxonomy with
  | None -> [ product ]
  | Some tax -> ( match Taxonomy.descendants tax product with [] -> [ product ] | l -> l)

let is_closed (t : task) = t.status = "done" || t.status = "dropped"

let matches ~world:_ ?taxonomy ~project (f : task_filter) (t : task) =
  let eq_opt wanted actual = match wanted with None -> true | Some w -> w = actual in
  (match f.product with
  | None -> true
  | Some p -> List.mem t.product (product_scope ?taxonomy p))
  && (match project with None -> true | Some id -> t.project_id = Some id)
  && (match f.track with None -> true | Some w -> t.track = Some w)
  && eq_opt f.owner t.owner
  && eq_opt f.category t.category
  && (match f.session with
     | None -> true
     | Some s -> List.exists (fun (l : session_link) -> l.session = s) t.sessions)

let compare_tasks (a : task) (b : task) =
  let c = String.compare a.priority b.priority in
  if c <> 0 then c else String.compare a.id b.id

let list_tasks world ?taxonomy (f : task_filter) =
  let ( let* ) = Result.bind in
  let* project =
    match f.project with
    | None -> Ok None
    | Some r -> Result.map Option.some (Refs.project world r)
  in
  let status_ok (t : task) =
    if f.status <> [] then List.mem t.status f.status
    else f.include_closed || not (is_closed t)
  in
  Ok
    (Smap.fold (fun _ t acc -> t :: acc) world.tasks []
    |> List.filter (fun t -> matches ~world ?taxonomy ~project f t && status_ok t)
    |> List.sort compare_tasks)

type task_view = {
  task : task;
  project_title : string option;
  open_blockers : blocker list;
  notes : string;
  warnings : string list;
}

let trim_newlines s =
  let n = String.length s in
  let i = ref 0 and j = ref n in
  while !i < n && s.[!i] = '\n' do incr i done;
  while !j > !i && s.[!j - 1] = '\n' do decr j done;
  String.sub s !i (!j - !i)

let notes_of ctx (t : task) =
  match Store.find_task_file ctx ~product:t.home_product ~id:t.id with
  | None -> ("", [])
  | Some path -> (
      match Store.read_task_file path with
      | exception Sys_error why -> ("", [ Printf.sprintf "cannot read %s: %s" path why ])
      | meta, body ->
          let mismatch (key, want) =
            match List.assoc_opt key meta with
            | Some got when got <> want ->
                [ Printf.sprintf "%s: %s mismatch (file %S, event %S); using event"
                    (Filename.basename path) key got want ]
            | _ -> []
          in
          ( trim_newlines body,
            List.concat_map mismatch
              [ ("id", t.id); ("project", t.home_product); ("category", t.home_category) ] ))

let get_task ctx world ref_ =
  let ( let* ) = Result.bind in
  let* id = Refs.task world ref_ in
  let task = Smap.find id world.tasks in
  let* notes, warnings = Err.protect (fun () -> notes_of ctx task) in
  let project_title =
    Option.bind task.project_id (fun pid ->
        Option.map (fun p -> p.title_p) (Smap.find_opt pid world.projects))
  in
  Ok
    {
      task; project_title; notes; warnings;
      open_blockers = List.filter (fun b -> b.resolved = None) task.blockers;
    }

type project_row = {
  project : project;
  open_tasks : int;
  done_tasks : int;
  progress : float option;
}

let row_of world (p : project) =
  let tasks = Smap.fold (fun _ (t : task) acc -> if t.project_id = Some p.pid then t :: acc else acc) world.tasks [] in
  let open_tasks = List.length (List.filter (fun t -> not (is_closed t)) tasks) in
  let done_tasks = List.length (List.filter (fun (t : task) -> t.status = "done") tasks) in
  let total = open_tasks + done_tasks in
  {
    project = p; open_tasks; done_tasks;
    progress = (if total = 0 then None else Some (float_of_int done_tasks /. float_of_int total));
  }

let list_projects world ?taxonomy ?product ?(status = []) ?quarter ?(include_closed = false) () =
  let status_ok (p : project) =
    if status <> [] then List.mem p.status_p status
    else include_closed || p.status_p = "active"
  in
  Smap.fold (fun _ p acc -> p :: acc) world.projects []
  |> List.filter (fun (p : project) ->
         status_ok p
         && (match product with
            | None -> true
            | Some prod -> List.mem p.product_p (product_scope ?taxonomy prod))
         && (match quarter with None -> true | Some q -> p.quarter = Some q))
  |> List.sort (fun (a : project) (b : project) ->
         compare (a.product_p, a.title_p, a.pid) (b.product_p, b.title_p, b.pid))
  |> List.map (row_of world)

let get_project world ref_ =
  Result.map (fun id -> row_of world (Smap.find id world.projects)) (Refs.project world ref_)

let tasks_of_project world pid =
  Smap.fold (fun _ (t : task) acc -> if t.project_id = Some pid then t :: acc else acc) world.tasks []
  |> List.sort (fun a b ->
         match (is_closed a, is_closed b) with
         | false, true -> -1
         | true, false -> 1
         | _ -> compare_tasks a b)
