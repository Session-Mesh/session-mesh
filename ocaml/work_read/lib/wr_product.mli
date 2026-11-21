(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [product]: every task of a product and of its child products (the scope of
    the [tree] counts of [products]), closed ones included, for the board and
    the timeline of the Projects view's product page. *)

val max_tasks : int
(** 1000 tasks; the others are counted in [tasks_omitted] and the document is
    [truncated]. *)

val run : Wr_load.t -> string -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
(** [product] (the id), [scope] (the product and its descendants), [projects]
    (every project of the scope, closed ones included), [tasks] (open ones
    first, then by priority and id; each with its [tags] and
    its board [column], {!Wr_projects.column_of}), [column_counts]
    (every task of the scope per board column, the omitted ones included) and
    [totals] ({!Wr_stats.json} of every task of the scope: [totals.open] is the
    [tree.open] of [products]). [not_found] for a product the taxonomy does not
    know; [repository] when the taxonomy cannot be read (as [products]:
    without it there is no scope). *)
