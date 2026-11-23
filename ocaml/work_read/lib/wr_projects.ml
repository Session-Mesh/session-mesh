(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module R = Work_mcp.Work_render
module E = Work_mcp.Work_err
open E

let max_projects = 200
let max_tasks = 200
let max_edges = 300
let max_project_events = 40
let column_names = [ "todo"; "in_progress"; "blocked"; "done"; "other" ]

(* Every task is in exactly one column. Blocked comes first, with the meaning
   of {!Wr_stats.is_blocked}, so that the column, [blocked_tasks] and the
   [blocked] section of [reprise] agree; a status outside the known ones
   (a hand-edited file) is in [other]. *)
let column_of (t : W.Model.task) =
  if not (Wr_stats.is_open t) then "done"
  else if Wr_stats.is_blocked t then "blocked"
  else
    match t.status with
    | "in_progress" -> "in_progress"
    | "inbox" | "todo" -> "todo"
    | _ -> "other"

let light_json world (row : W.Query.project_row) =
  let p = row.project in
  let stats = Wr_stats.of_tasks world (W.Query.tasks_of_project world p.pid) in
  `Assoc
    ([
       ("id", R.tstr ~max:40 p.pid);
       ("title", R.tstr ~max:200 p.title_p);
       ("product", R.tstr p.product_p);
       ("status", R.tstr ~max:40 p.status_p);
     ]
    @ R.opt_tstr ~max:40 "quarter" p.quarter
    @ R.opt_tstr "owner" p.owner_p
    @ Wr_stats.json stats
    @ R.opt "last_activity" R.ts p.last_ts_p)

(* Tasks that belong to no project, per product (closed products included
   only through their tasks), in taxonomy order. *)
let no_project_entries (loaded : Wr_load.t) product =
  let world = Wr_load.world loaded in
  let products =
    match loaded.snapshot.taxonomy with
    | None -> []
    | Some tax -> (
        match product with
        | None -> W.Taxonomy.products tax
        | Some p -> W.Query.product_scope ~taxonomy:tax p)
  in
  List.filter_map
    (fun id ->
      let tasks =
        W.Model.Smap.fold
          (fun _ (t : W.Model.task) acc ->
            if t.product = id && t.project_id = None then t :: acc else acc)
          world.tasks []
      in
      let stats = Wr_stats.of_tasks world tasks in
      if stats.open_tasks + stats.done_tasks = 0 then None
      else Some (`Assoc (("product", R.tstr id) :: Wr_stats.json stats)))
    products

let list (loaded : Wr_load.t) ~product ~all =
  let* () = Wr_scope.check_product loaded product in
  let world = Wr_load.world loaded in
  let rows =
    W.Query.list_projects world ?taxonomy:loaded.snapshot.taxonomy ?product
      ~include_closed:all ()
  in
  Ok
    (Wr_out.document "projects"
       (Wr_out.list "projects" max_projects (List.map (light_json world) rows)
       @ [ ("total", `Int (List.length rows)) ]
       @ Wr_out.list "no_project" max_projects
           (no_project_entries loaded product)
       @ Wr_load.warnings_json loaded))

let column_ids name tasks =
  List.filter_map
    (fun (t : W.Model.task) ->
      if column_of t = name then Some (R.tstr ~max:40 t.id) else None)
    tasks

(* The columns of the shown tasks; [columns_omitted] counts, per column, the
   tasks of the project left out of [tasks] (only when some are). *)
let columns_fields ~shown ~all =
  let omitted =
    List.filter_map
      (fun name ->
        let cut =
          List.length (column_ids name all)
          - List.length (column_ids name shown)
        in
        if cut > 0 then Some (name, `Int cut) else None)
      column_names
  in
  ( "columns",
    `Assoc
      (List.map
         (fun name -> (name, `List (column_ids name shown)))
         column_names) )
  :: (if omitted = [] then [] else [ ("columns_omitted", `Assoc omitted) ])

(* One edge per [blocked_by] entry of the shown tasks; [to_in_project] looks at
   every task of the project. *)
let edges_json (world : W.Model.world) ~(all : W.Model.task list)
    (tasks : W.Model.task list) =
  let in_project id = List.exists (fun (t : W.Model.task) -> t.id = id) all in
  List.concat_map
    (fun (t : W.Model.task) ->
      List.map
        (fun target ->
          let found = W.Model.Smap.find_opt target world.tasks in
          `Assoc
            ([
               ("from", R.tstr ~max:40 t.id);
               ("to", R.tstr ~max:40 target);
               ("state", `String (Wr_stats.state world target));
             ]
            @ R.opt "to_title"
                (fun (d : W.Model.task) -> R.tstr ~max:200 d.title)
                found
            @ R.opt "to_status"
                (fun (d : W.Model.task) -> R.tstr ~max:40 d.status)
                found
            @ [ ("to_in_project", `Bool (in_project target)) ]))
        t.blocked_by)
    tasks

let project_fields (row : W.Query.project_row) stats =
  let base = match R.project_json row with `Assoc l -> l | _ -> [] in
  base
  @ [ ("created", R.tstr ~max:40 row.project.created_p) ]
  @ R.opt "last_activity" R.ts row.project.last_ts_p
  @ [
      ("blocked_tasks", `Int stats.Wr_stats.blocked_tasks);
      ("dependency_open_tasks", `Int stats.dependency_open_tasks);
      ("blockers", `Int stats.open_blockers);
    ]

let detail (loaded : Wr_load.t) reference =
  let world = Wr_load.world loaded in
  let* row = lift (W.Query.get_project world reference) in
  let pid = row.project.pid in
  let all_tasks = W.Query.tasks_of_project world pid in
  let tasks, _ = R.cap max_tasks all_tasks in
  let stats = Wr_stats.of_tasks world all_tasks in
  let keep (t : W.Model.task) = t.project_id = Some pid in
  let task_ids = pid :: List.map (fun (t : W.Model.task) -> t.id) all_tasks in
  Ok
    (Wr_out.document "project"
       ([ ("project", `Assoc (project_fields row stats)) ]
       @ (match Wr_attachment.run loaded pid row.project.product_p with
         | Ok _ -> [ ("session_tools", `Bool true) ]
         | Error _ -> [])
       @ Wr_out.list "tasks" max_tasks
           (List.map
              (Wr_view.task_row ~attempts:loaded.attempts world)
              all_tasks)
       @ columns_fields ~shown:tasks ~all:all_tasks
       @ Wr_out.list "dependencies" max_edges
           (edges_json world ~all:all_tasks tasks)
       @ [ ("reprise", `Assoc (Wr_resume.sections loaded ~keep ())) ]
       @ Wr_questions.fields ~brief:true ~about:task_ids loaded.questions
       @ Wr_out.list "timeline" max_project_events
           (List.rev_map Wr_view.event_json row.project.timeline_p)
       @ Wr_load.warnings_json loaded))
