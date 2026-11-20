(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The [work_*] MCP server: 19 tools over the worklog library. Questions
    and attempts are the library's extensions (see {!Work_questions} and
    {!Work_attempts}); [work_answer] records an answer through
    {!Work_questions.answer_once}, [work_attempt] the end of an attempt through
    {!Work_attempts.record}. *)

val tools : Mcp_kit.Tool.t list
(** The 19 tools, in declaration order. *)

val server : unit -> Mcp_kit.Server.t
(** A stdio server declaration carrying {!tools} and the instructions. *)
