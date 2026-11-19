(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The question tools and the view tool: [work_ask], [work_answer],
    [work_list_questions], [work_open_view]. [work_answer] relays the owner's
    answer given in the agent's conversation; it records it with
    {!Work_questions.answer_once} (one answer per question, a repeated
    identical answer is a duplicate, another one is [already_answered]).
    [work_open_view] needs the interface, which does not exist yet: it
    validates its input and reports [opened = false]. *)

val tools : Mcp_kit.Tool.t list
