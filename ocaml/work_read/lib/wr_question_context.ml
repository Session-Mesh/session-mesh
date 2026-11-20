(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module R = Work_mcp.Work_render
module Q = Work_mcp.Work_questions

let max_title = 200

(* The category of a product: the taxonomy's, else the one the task or the
   project recorded (a product missing from the taxonomy). *)
let category_of (loaded : Wr_load.t) product recorded =
  match Option.bind loaded.snapshot.taxonomy (fun t -> W.Taxonomy.category_of t product) with
  | Some key -> Some key
  | None -> if recorded = "" then None else Some recorded

let project_fields (world : W.Model.world) = function
  | None -> []
  | Some pid -> (
      match W.Model.Smap.find_opt pid world.projects with
      | Some p -> R.opt_tstr ~max:40 "project" (Some pid) @ R.opt_tstr ~max:max_title "project_title" (Some p.title_p)
      | None -> R.opt_tstr ~max:40 "project" (Some pid))

let fields (loaded : Wr_load.t) (q : Q.question) =
  let world = Wr_load.world loaded in
  let place product recorded =
    R.opt_tstr ~max:100 "product" (Some product) @ R.opt_tstr ~max:100 "category" (category_of loaded product recorded)
  in
  match q.about with
  | Some id when W.Model.Smap.mem id world.tasks ->
      let t = W.Model.Smap.find id world.tasks in
      R.opt_tstr ~max:max_title "task_title" (Some t.title) @ project_fields world t.project_id @ place t.product t.category
  | Some id when W.Model.Smap.mem id world.projects ->
      let p = W.Model.Smap.find id world.projects in
      project_fields world (Some id) @ place p.product_p p.category_p
  | _ -> []

let add (loaded : Wr_load.t) q = function
  | `Assoc json -> (
      match fields loaded q with [] -> `Assoc json | context -> `Assoc (json @ [ ("context", `Assoc context) ]))
  | other -> other
