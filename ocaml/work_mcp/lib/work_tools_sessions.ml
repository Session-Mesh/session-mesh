(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module R = Work_render
module T = Work_tool
open Work_err

let max_sessions = 100

type found = {
  agent : string;
  name : string;
  mutable repo : string option;
  mutable branch : string option;
  mutable last : int;
  mutable linked : int;
  mutable tasks : string list;
}

let event_session (ev : W.Event.t) = W.Event.get_string ev "session"

let last_activity (t : W.Model.task) (l : W.Model.session_link) =
  List.fold_left
    (fun acc (ev : W.Event.t) -> if event_session ev = Some l.session then max acc ev.ts else acc)
    l.linked_at t.timeline

let absorb table (t : W.Model.task) (l : W.Model.session_link) =
  let key = (l.agent, l.session) in
  let f =
    match Hashtbl.find_opt table key with
    | Some f -> f
    | None ->
        let f = { agent = l.agent; name = l.session; repo = None; branch = None; last = 0; linked = 0; tasks = [] } in
        Hashtbl.add table key f;
        f
  in
  if l.linked_at >= f.linked then begin
    f.linked <- l.linked_at;
    f.repo <- l.repo;
    f.branch <- l.branch
  end;
  f.last <- max f.last (last_activity t l);
  if not (List.mem t.id f.tasks) then f.tasks <- f.tasks @ [ t.id ]

let found_json f =
  `Assoc
    ([ ("name", R.tstr ~max:100 f.name); ("agent", R.tstr ~max:100 f.agent) ]
    @ R.opt_repo f.repo @ R.opt_tstr ~max:100 "branch" f.branch
    @ [ ("last_activity", R.ts f.last) ]
    @ R.capped "tasks" 20 (List.map (fun id -> `String id) f.tasks))

(* The sessions linked to these tasks, or only the session [only] (and agent
   [agent]) when given. *)
let collect ?only ?agent tasks =
  let table = Hashtbl.create 16 in
  let wanted (l : W.Model.session_link) =
    (only = None || Some l.session = only) && (agent = None || Some l.agent = agent)
  in
  List.iter (fun (t : W.Model.task) -> List.iter (absorb table t) (List.filter wanted t.sessions)) tasks;
  Hashtbl.fold (fun _ f acc -> f :: acc) table []
  |> List.sort (fun a b -> compare (b.last, a.name) (a.last, b.name))

let scope_tasks (snap : W.Reader.snapshot) args =
  let* task = Work_args.opt_string args "task" in
  let* product = Work_args.opt_string args "product" in
  let* project = Work_args.opt_string args "project" in
  let* track = Work_args.opt_string args "track" in
  let world = snap.loaded.world in
  match (task, product, project, track) with
  | None, None, None, None -> Error (invalid "give one of task, product, project, track")
  | Some task, None, None, None ->
      let* id = lift (W.Refs.task world task) in
      Ok [ W.Model.Smap.find id world.tasks ]
  | Some _, _, _, _ -> Error (invalid "task cannot be combined with product, project or track")
  | None, _, _, _ ->
      let filter = { W.Query.no_filter with product; project; track; include_closed = true } in
      lift (W.Query.list_tasks world ?taxonomy:snap.taxonomy filter)

let find_sessions args =
  let* include_closed = Work_args.opt_bool args "include_closed" in
  let* limit = Work_args.limit args ~default:50 ~max:max_sessions in
  let* () =
    if include_closed = Some false then
      Error
        (make "not_available"
           "include_closed=false needs the open or closed state of sessions, which the Mesh holds and this server does not query; leave include_closed at its default (true)")
    else Ok ()
  in
  let* ctx = Work_repo.context () in
  let* snap = lift (W.Reader.snapshot ctx) in
  let* tasks = scope_tasks snap args in
  let sessions = collect tasks in
  Ok
    (`Assoc
      (R.capped "sessions" limit (List.map found_json sessions)
      @ [ ("total", `Int (List.length sessions)); ("include_closed", `Bool true) ]
      @ R.warnings_json snap.warnings))

let find_sessions_tool =
  T.make ~name:"work_find_sessions"
    ~description:
      "Sessions that wrote on tasks of a product (with descendants), a project, a track, or on one \
       task, closed ones included. Returns only name, agent, repo, branch, last activity and \
       task ids. Whether a session is still open is known to the Mesh, not to this server."
    ~input_schema:
      (T.object_ ~required:[]
         [
           ("product", T.string ());
           ("project", T.string ~max:40 ());
           ("task", T.string ~max:40 ());
           ("track", T.string ());
           ("include_closed", T.boolean ~description:"Default true; false is not available." ());
           T.limit_property ~max:max_sessions;
         ])
    find_sessions

let session_events ~name ~agent tasks =
  let mine ev =
    event_session ev = Some name
    && (agent = None || W.Event.get_string ev "agent" = agent)
  in
  List.concat_map (fun (t : W.Model.task) -> List.filter mine t.timeline) tasks
  |> List.sort (fun a b -> W.Event.compare b a)

let get_session args =
  let* name = Work_args.string args "session" in
  let* agent = Work_args.opt_string args "agent" in
  let* ctx = Work_repo.context () in
  let* snap = lift (W.Reader.snapshot ctx) in
  let linked (t : W.Model.task) =
    List.exists (fun (l : W.Model.session_link) -> l.session = name && (agent = None || Some l.agent = agent)) t.sessions
  in
  let tasks = List.filter linked (List.map snd (W.Model.Smap.bindings snap.loaded.world.tasks)) in
  let all_questions, collisions = Work_questions.of_events_report snap.loaded.events in
  let questions =
    List.filter
      (fun (q : Work_questions.question) ->
        q.session = Some name && (agent = None || q.agent = agent))
      all_questions
  in
  if tasks = [] && questions = [] then Error (not_found "no activity recorded for session %s" name)
  else
    let found = collect ~only:name ?agent tasks in
    Ok
      (`Assoc
        ([ ("session", R.tstr ~max:100 name) ]
        @ R.capped "links" 20 (List.map found_json found)
        @ R.capped "tasks" 40 (List.map (fun t -> R.task_row t) tasks)
        @ R.capped "events_newest_first" 40 (List.map R.event_json (session_events ~name ~agent tasks))
        @ R.capped "questions" 20 (List.map R.question_json (List.rev questions))
        @ R.warnings_json (snap.warnings @ collisions)))

let get_session_tool =
  T.make ~name:"work_get_session"
    ~description:
      "The other way round: the tasks a session is linked to, its newest events and its questions. \
       Takes the session name; never returns its folder."
    ~input_schema:
      (T.object_ ~required:[ "session" ]
         [ ("session", T.string ~max:200 ()); ("agent", T.string ~max:40 ()) ])
    get_session

let tools = [ find_sessions_tool; get_session_tool ]
