(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The write tools: [work_add_task], [work_add_project], [work_add_product],
    [work_update], [work_log], [work_block], [work_unblock]. Every write that
    reaches a task also links the calling session to it (once). None of them
    can write a [question] or [answer] event. *)

val tools : Mcp_kit.Tool.t list

val log_kinds : string list
(** The kinds [work_log] accepts: [progress], [note], [decision], [learning],
    [risk], [metric], [mentoring], [shipped]. *)
