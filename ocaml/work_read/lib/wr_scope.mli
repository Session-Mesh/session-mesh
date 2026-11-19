(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Checking the product of a request against the taxonomy. *)

val check_product : Wr_load.t -> string option -> (unit, Work_mcp.Work_err.t) result
(** [not_found] for a product the taxonomy does not know; nothing to check
    when no product is given or the taxonomy cannot be read. *)

val tasks_of_product :
  Wr_load.t -> string -> Mesh_worklog.Model.task list
(** Tasks of a product and its descendants (closed ones included). *)
