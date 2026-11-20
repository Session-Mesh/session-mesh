(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module R = Work_mcp.Work_render
module Q = Work_mcp.Work_questions

let max_tasks = 4000
let max_projects = 1000
let max_questions = 1000
let max_title = 100

(* Most recent activity first, then by id: a cut list keeps the ids most
   likely to be printed in a terminal. *)
let by_activity ts_a id_a ts_b id_b =
  compare
    (Option.value ~default:0 ts_b, id_a)
    (Option.value ~default:0 ts_a, id_b)

let entry id title =
  `Assoc [ ("id", R.tstr ~max:40 id); ("title", R.tstr ~max:max_title title) ]

let tasks (world : W.Model.world) =
  W.Model.Smap.fold (fun _ t acc -> t :: acc) world.tasks []
  |> List.sort (fun (a : W.Model.task) (b : W.Model.task) ->
      by_activity a.last_ts a.id b.last_ts b.id)
  |> List.map (fun (t : W.Model.task) -> entry t.id t.title)

let projects (world : W.Model.world) =
  W.Model.Smap.fold (fun _ p acc -> p :: acc) world.projects []
  |> List.sort (fun (a : W.Model.project) (b : W.Model.project) ->
      by_activity a.last_ts_p a.pid b.last_ts_p b.pid)
  |> List.map (fun (p : W.Model.project) -> entry p.pid p.title_p)

(* The project a question is about, directly or through its task. *)
let project_of (world : W.Model.world) = function
  | Some id when W.Model.Smap.mem id world.tasks ->
      (W.Model.Smap.find id world.tasks).project_id
  | Some id when W.Model.Smap.mem id world.projects -> Some id
  | _ -> None

let question (world : W.Model.world) (q : Q.question) =
  `Assoc
    ([ ("id", R.tstr ~max:40 q.id); ("title", R.tstr ~max:max_title q.text) ]
    @ R.opt_tstr ~max:40 "about" q.about
    @ R.opt_tstr ~max:40 "project" (project_of world q.about))

let run (loaded : Wr_load.t) =
  let world = Wr_load.world loaded in
  Ok
    (Wr_out.document "ids"
       (Wr_out.list "tasks" max_tasks (tasks world)
       @ Wr_out.list "projects" max_projects (projects world)
       @ Wr_out.list "questions" max_questions
           (List.rev_map (question world) loaded.questions)))
