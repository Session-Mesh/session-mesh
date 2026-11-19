(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The session tools: [work_find_sessions] and [work_get_session]. Sessions
    are known only through the [session_linked] events of the data repository
    (a session is linked when it writes on a task); the folder a session
    worked in is stored there but never returned. *)

val tools : Mcp_kit.Tool.t list
