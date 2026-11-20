(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The attempt tool, [work_attempt]: records the end of a pass of work on a
    task with {!Work_attempts.record} and links the calling session to the
    task. *)

val tools : Mcp_kit.Tool.t list
