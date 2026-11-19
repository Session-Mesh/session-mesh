(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [products]: the product tree with counts. Counts of a product are those of
    its own tasks; [tree] adds its descendants'. At most 200 products per
    category. *)

val max_products : int

val run : Wr_load.t -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
