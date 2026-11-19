(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The [work_*] MCP server: 17 tools over the worklog library. Questions
    are the library's extension (see {!Work_questions}); the answer writer is
    {!Work_questions.answer}, not a tool. *)

val tools : Mcp_kit.Tool.t list
(** The 17 tools, in declaration order. *)

val server : unit -> Mcp_kit.Server.t
(** A stdio server declaration carrying {!tools} and the instructions. *)
