(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module R = Work_mcp.Work_render
module E = Work_mcp.Work_err

let max_products = 200

let tasks_of_product (world : W.Model.world) product =
  W.Model.Smap.fold (fun _ (t : W.Model.task) acc -> if t.product = product then t :: acc else acc) world.tasks []

let active_projects (world : W.Model.world) product =
  W.Model.Smap.fold
    (fun _ (p : W.Model.project) n -> if p.product_p = product && p.status_p = "active" then n + 1 else n)
    world.projects 0

let product_json world taxonomy (id, parent, _category) =
  let tasks = tasks_of_product world id in
  let own = Wr_stats.of_tasks world tasks in
  let tree =
    List.fold_left
      (fun acc child -> Wr_stats.add acc (Wr_stats.of_tasks world (tasks_of_product world child)))
      Wr_stats.empty
      (W.Taxonomy.descendants taxonomy id)
  in
  let no_project_open =
    List.length (List.filter (fun (t : W.Model.task) -> Wr_stats.is_open t && t.project_id = None) tasks)
  in
  `Assoc
    ([ ("id", R.tstr ~max:100 id) ]
    @ R.opt_tstr ~max:100 "parent" parent
    @ Wr_stats.json own
    @ [
        ("tree", `Assoc (Wr_stats.json tree));
        ("projects", `Int (active_projects world id));
        ("no_project_open", `Int no_project_open);
      ])

let category_json world taxonomy (entries : (string * string option * string) list) (c : W.Taxonomy.category) =
  let products = List.filter (fun (_, _, key) -> key = c.key) entries in
  `Assoc
    ([ ("key", R.tstr ~max:100 c.key); ("name", R.tstr ~max:100 c.name) ]
    @ Wr_out.list "products" max_products (List.map (product_json world taxonomy) products))

let unlisted world taxonomy =
  W.Model.Smap.fold
    (fun _ (t : W.Model.task) n -> if W.Taxonomy.has_product taxonomy t.product then n else n + 1)
    world.W.Model.tasks 0

let run (loaded : Wr_load.t) =
  match loaded.snapshot.taxonomy with
  | None -> Error (E.make "repository" "taxonomy.yaml cannot be read")
  | Some taxonomy ->
      let world = Wr_load.world loaded in
      let categories = List.map (category_json world taxonomy taxonomy.entries) taxonomy.categories in
      let totals = Wr_stats.of_tasks world (List.map snd (W.Model.Smap.bindings world.tasks)) in
      Ok
        (Wr_out.document "products"
           ([ ("categories", `List categories); ("totals", `Assoc (Wr_stats.json totals)) ]
           @ [ ("unlisted_tasks", `Int (unlisted world taxonomy)) ]
           @ Wr_load.warnings_json loaded))
