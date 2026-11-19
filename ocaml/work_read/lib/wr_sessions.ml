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

let max_sessions = 100

(* The kind, the resolved id and the tasks of a target. *)
let resolve (loaded : Wr_load.t) = function
  | Wr_args.Product product ->
      let* () = Wr_scope.check_product loaded (Some product) in
      Ok ("product", product, Wr_scope.tasks_of_product loaded product)
  | Wr_args.Project reference ->
      let world = Wr_load.world loaded in
      let* id = lift (W.Refs.project world reference) in
      Ok ("project", id, W.Query.tasks_of_project world id)
  | Wr_args.Task reference ->
      let world = Wr_load.world loaded in
      let* id = lift (W.Refs.task world reference) in
      Ok ("task", id, [ W.Model.Smap.find id world.tasks ])

let run loaded target =
  let* kind, id, tasks = resolve loaded target in
  let sessions = Wr_view.collect tasks in
  Ok
    (Wr_out.document "sessions-of"
       ([ ("scope", `Assoc [ ("kind", `String kind); ("id", R.tstr id) ]) ]
       @ Wr_out.list "sessions" max_sessions (List.map Wr_view.linked_json sessions)
       @ [ ("total", `Int (List.length sessions)); ("tasks_considered", `Int (List.length tasks)) ]
       @ Wr_load.warnings_json loaded))
