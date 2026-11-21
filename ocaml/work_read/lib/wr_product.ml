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

let max_tasks = 1000
let max_tags = 20

(* Open tasks first, then by priority and id: the order of a project's tasks. *)
let order (a : W.Model.task) (b : W.Model.task) =
  match (Wr_stats.is_open a, Wr_stats.is_open b) with
  | true, false -> -1
  | false, true -> 1
  | _ -> compare (a.priority, a.id) (b.priority, b.id)

let row (loaded : Wr_load.t) world (t : W.Model.task) =
  let base =
    match Wr_view.task_row ~attempts:loaded.attempts world t with
    | `Assoc l -> l
    | _ -> []
  in
  `Assoc
    (base
    @ [ ("column", `String (Wr_projects.column_of t)) ]
    @ Wr_out.list "tags" max_tags
        (List.map (fun tag -> R.tstr ~max:100 tag) t.tags))

(* Every task of the scope per column, the ones left out of [tasks] included. *)
let column_counts tasks =
  `Assoc
    (List.map
       (fun name ->
         ( name,
           `Int
             (List.length
                (List.filter (fun t -> Wr_projects.column_of t = name) tasks))
         ))
       Wr_projects.column_names)

let run (loaded : Wr_load.t) product =
  let* () =
    if loaded.snapshot.taxonomy = None then Error (E.make "repository" "taxonomy.yaml cannot be read")
    else Ok ()
  in
  let* () = Wr_scope.check_product loaded (Some product) in
  let world = Wr_load.world loaded and taxonomy = loaded.snapshot.taxonomy in
  let tasks = List.sort order (Wr_scope.tasks_of_product loaded product) in
  let projects =
    W.Query.list_projects world ?taxonomy ~product ~include_closed:true ()
  in
  Ok
    (Wr_out.document "product"
       ([
          ("product", R.tstr ~max:100 product);
          ( "scope",
            `List
              (List.map
                 (fun id -> R.tstr ~max:100 id)
                 (W.Query.product_scope ?taxonomy product)) );
        ]
       @ Wr_out.list "projects" Wr_projects.max_projects
           (List.map (Wr_projects.light_json world) projects)
       @ Wr_out.list "tasks" max_tasks (List.map (row loaded world) tasks)
       @ [
           ("column_counts", column_counts tasks);
           ("totals", `Assoc (Wr_stats.json (Wr_stats.of_tasks world tasks)));
         ]
       @ Wr_load.warnings_json loaded))
