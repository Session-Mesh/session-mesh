(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [sessions-of]: the sessions linked to the tasks of a product (with its
    descendants), a project or one task, closed sessions included (the data
    repository does not know which sessions are still open). At most 100
    sessions; each is name, agent, repository name, branch, last activity,
    and the task and project ids it touched here. *)

val max_sessions : int

val run : Wr_load.t -> Wr_args.target -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
