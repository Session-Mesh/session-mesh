(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Linking the calling session to a task after a write, and the canonical id
    of a task. *)

val report : (_, Mesh_worklog.Err.t) result -> unit
(** A failed link is added to the call's [write_warnings] (never a failure of
    the write); a success or an already linked session says nothing. *)

val task : Mesh_worklog.Ctx.t -> string -> unit
(** Link the calling session to the task (a reference), once. Nothing without
    a session id. *)

val canonical_task : Mesh_worklog.Ctx.t -> string -> (string, Work_err.t) result
(** The full id of a task given by a unique prefix. *)
