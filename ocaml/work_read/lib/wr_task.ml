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

let max_notes = 8000
let max_timeline = 60
let max_list = 20

let target_json (world : W.Model.world) id =
  let found = W.Model.Smap.find_opt id world.tasks in
  `Assoc
    ([ ("id", R.tstr ~max:40 id); ("state", `String (Wr_stats.state world id)) ]
    @ R.opt "title" (fun (d : W.Model.task) -> R.tstr ~max:200 d.title) found
    @ R.opt "status" (fun (d : W.Model.task) -> R.tstr ~max:40 d.status) found)

let blocking_ids (world : W.Model.world) id =
  W.Model.Smap.fold
    (fun other (t : W.Model.task) acc -> if List.mem id t.blocked_by then other :: acc else acc)
    world.tasks []
  |> List.rev

let project_json (world : W.Model.world) (t : W.Model.task) =
  match t.project_id with
  | None -> []
  | Some pid ->
      [ ("project", `Assoc (("id", R.tstr ~max:40 pid) :: R.opt_tstr "title" (Wr_view.project_title world t))) ]

let run (loaded : Wr_load.t) reference =
  let world = Wr_load.world loaded in
  let* view = lift (W.Query.get_task loaded.ctx world reference) in
  let t = view.task in
  let resolved = List.length t.blockers - List.length view.open_blockers in
  Ok
    (Wr_out.document "task"
       ([ ("task", R.task_full ?project_title:view.project_title t) ]
       @ project_json world t
       @ [ ("notes", Wr_out.text ~max:max_notes view.notes); ("resolved_blockers", `Int resolved) ]
       @ Wr_out.list "open_blockers" max_list (List.map R.blocker_json view.open_blockers)
       @ Wr_out.list "blocked_by" max_list (List.map (target_json world) t.blocked_by)
       @ Wr_out.list "blocking" max_list (List.map (target_json world) (blocking_ids world t.id))
       @ Wr_out.list "sessions" max_list (List.map Wr_view.linked_json (Wr_view.collect [ t ]))
       @ Wr_out.list "timeline" max_timeline (List.rev_map Wr_view.event_json t.timeline)
       @ Wr_questions.fields ~about:[ t.id ] loaded.questions
       @ [ ("attempts", R.attempts_json (Work_mcp.Work_attempts.summary (Work_mcp.Work_attempts.of_task t.id loaded.attempts))) ]
       @ R.warnings_json (loaded.warnings @ view.warnings)))
