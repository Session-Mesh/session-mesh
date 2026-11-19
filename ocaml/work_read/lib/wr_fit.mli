(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Bringing a document under the output bound instead of failing: stored data
    must always stay readable.

    The lists of {!order} are cut one after the other, least useful first:
    each list loses its second half (its head is kept) as many times as
    needed, down to one item, and [<key>_omitted] grows by what was cut. When
    [tasks] is cut, [columns] keeps only the ids still shown and
    [columns_omitted] counts the others per column. If the document is still
    too large, {!Work_mcp.Work_tool.fit} cuts what remains (the largest value
    first, strings included). A cut document has [truncated: true] as its
    last field. *)

val order : string list list
(** The cut order, as paths of lists: [questions], [timeline],
    [dependencies], [sessions], the [reprise] sections ([todo], [due],
    [stale], [in_progress], [blocked]), the same sections at the top level
    ([resume]), [blocking], [blocked_by], [no_project], [projects], then
    [tasks]. A path absent from a document is skipped. *)

val fit : max:int -> Yojson.Safe.t -> Yojson.Safe.t option
(** The document unchanged when it fits in [max] bytes, else cut as
    described; [None] only when nothing is left to cut (not reached by stored
    data). *)
