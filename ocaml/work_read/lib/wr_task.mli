(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [task]: one task folded, with its open blockers, the state of what it
    waits on and of what waits on it, the sessions linked to it (names, agent,
    repository name, branch, last activity: never a folder), its notes
    (at most 8000 bytes), a timeline of typed events with provenance (newest
    first, at most 60) and its questions. *)

val max_notes : int
val max_timeline : int
val max_list : int
(** 20 entries for blockers, [blocked_by], [blocking] and sessions. *)

val run : Wr_load.t -> string -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
