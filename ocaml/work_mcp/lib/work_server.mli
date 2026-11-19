(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The [work_*] MCP server: 18 tools over the worklog library. Questions
    are the library's extension (see {!Work_questions}); [work_answer] records
    an answer through {!Work_questions.answer_once}. *)

val tools : Mcp_kit.Tool.t list
(** The 18 tools, in declaration order. *)

val server : unit -> Mcp_kit.Server.t
(** A stdio server declaration carrying {!tools} and the instructions. *)
