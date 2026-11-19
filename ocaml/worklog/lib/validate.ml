(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let check = function None -> () | Some why -> Err.fail Err.Usage why
let taxonomy ctx = Err.unwrap (Taxonomy.load (Ctx.taxonomy_path ctx))

let product_category ctx product =
  match Taxonomy.category_of (taxonomy ctx) product with
  | Some category -> category
  | None -> Err.usage "unknown product %S (not in taxonomy.yaml)" product

let task (tx : Txn.t) reference =
  let world = tx.loaded.world in
  Model.Smap.find (Err.unwrap (Refs.task world reference)) world.Model.tasks
let project_id (tx : Txn.t) reference = Err.unwrap (Refs.project tx.loaded.world reference)
let json_of_option = function Some s -> `String s | None -> `Null
let text ~what value = check (Textcheck.body_text_error ~what value); value

let prov = function
  | None | Some "stated" -> []
  | Some p when List.mem p Fields.prov_values -> [ ("prov", `String p) ]
  | Some p -> Err.usage "prov must be one of %s, got %S" (String.concat ", " Fields.prov_values) p

let today (tx : Txn.t) = Tstamp.date_of tx.now
