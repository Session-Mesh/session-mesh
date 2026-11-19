(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module R = Work_mcp.Work_render

type linked = {
  agent : string;
  name : string;
  repo : string option;
  branch : string option;
  last : int;
  linked_at : int;
  tasks : string list;
  projects : string list;
}

let session_of_event (ev : W.Event.t) = W.Event.get_string ev "session"

let last_activity (t : W.Model.task) (l : W.Model.session_link) =
  List.fold_left
    (fun acc (ev : W.Event.t) -> if session_of_event ev = Some l.session then max acc ev.ts else acc)
    l.linked_at t.timeline

let add_unique x l = if List.mem x l then l else l @ [ x ]

(* The latest link of the session gives the repository and branch. *)
let merge (t : W.Model.task) (l : W.Model.session_link) = function
  | None ->
      {
        agent = l.agent;
        name = l.session;
        repo = Option.bind l.repo R.repo_name;
        branch = l.branch;
        last = last_activity t l;
        linked_at = l.linked_at;
        tasks = [ t.id ];
        projects = Option.to_list t.project_id;
      }
  | Some f ->
      let newer = l.linked_at >= f.linked_at in
      {
        f with
        repo = (if newer then Option.bind l.repo R.repo_name else f.repo);
        branch = (if newer then l.branch else f.branch);
        last = max f.last (last_activity t l);
        linked_at = (if newer then l.linked_at else f.linked_at);
        tasks = add_unique t.id f.tasks;
        projects = (match t.project_id with Some p -> add_unique p f.projects | None -> f.projects);
      }

let collect tasks =
  let table = Hashtbl.create 16 in
  List.iter
    (fun (t : W.Model.task) ->
      List.iter
        (fun (l : W.Model.session_link) ->
          let key = (l.agent, l.session) in
          Hashtbl.replace table key (merge t l (Hashtbl.find_opt table key)))
        t.sessions)
    tasks;
  Hashtbl.fold (fun _ f acc -> f :: acc) table []
  |> List.sort (fun a b -> compare (b.last, a.name) (a.last, b.name))

let max_ids = 20

let linked_json f =
  `Assoc
    ([ ("name", R.tstr ~max:100 f.name); ("agent", R.tstr ~max:100 f.agent) ]
    @ R.opt_str "repo" f.repo
    @ R.opt_tstr ~max:100 "branch" f.branch
    @ [ ("last_activity", R.ts f.last) ]
    @ Wr_out.list "tasks" max_ids (List.map (fun id -> R.tstr ~max:40 id) f.tasks)
    @ Wr_out.list "projects" max_ids (List.map (fun id -> R.tstr ~max:40 id) f.projects))

let event_json (ev : W.Event.t) =
  let prov =
    match W.Event.get_string ev "prov" with
    | Some p when List.mem p W.Fields.prov_values -> [ ("prov", `String p) ]
    | _ -> []
  in
  match R.event_json ev with `Assoc l -> `Assoc (l @ prov) | other -> other

let done_at (t : W.Model.task) =
  if t.status <> "done" then None
  else
    List.fold_left
      (fun acc (ev : W.Event.t) ->
        if
          ev.typ = "set"
          && W.Event.get_string ev "field" = Some "status"
          && W.Event.get_string ev "to" = Some "done"
        then Some ev.ts
        else acc)
      None t.timeline

let project_title (world : W.Model.world) (t : W.Model.task) =
  Option.bind t.project_id (fun pid ->
      Option.map (fun (p : W.Model.project) -> p.title_p) (W.Model.Smap.find_opt pid world.projects))

let max_blocked_by = 20
let max_session_names = 10

let task_row world (t : W.Model.task) =
  let base = match R.task_row ?project_title:(project_title world t) t with `Assoc l -> l | _ -> [] in
  let names = List.map (fun (l : W.Model.session_link) -> R.tstr ~max:100 l.session) t.sessions in
  `Assoc
    (base
    @ [ ("created", R.tstr ~max:40 t.created) ]
    @ R.opt_tstr ~max:40 "eta" t.eta
    @ R.opt_tstr ~max:40 "size" t.size
    @ R.opt "done_at" R.ts (done_at t)
    @ [ ("blockers", `Int (List.length (Wr_stats.open_blockers t))) ]
    @ Wr_out.list "blocked_by" max_blocked_by (List.map (fun id -> R.tstr ~max:40 id) t.blocked_by)
    @ [ ("dependency_open", `Bool (Wr_stats.is_open t && Wr_stats.unfinished_dependency world t)) ]
    @ Wr_out.list "sessions" max_session_names names)
