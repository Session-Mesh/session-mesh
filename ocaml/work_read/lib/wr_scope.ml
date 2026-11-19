(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module E = Work_mcp.Work_err

let check_product (loaded : Wr_load.t) = function
  | None -> Ok ()
  | Some product -> (
      match loaded.snapshot.taxonomy with
      | Some taxonomy when not (W.Taxonomy.has_product taxonomy product) ->
          Error (E.not_found "unknown product %s" product)
      | _ -> Ok ())

let tasks_of_product (loaded : Wr_load.t) product =
  let world = Wr_load.world loaded in
  let filter = { W.Query.no_filter with product = Some product; include_closed = true } in
  List.filter
    (fun t -> W.Query.matches ~world ?taxonomy:loaded.snapshot.taxonomy ~project:None filter t)
    (List.map snd (W.Model.Smap.bindings world.tasks))
