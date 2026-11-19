(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The question tools and the view tool: [work_ask], [work_list_questions],
    [work_open_view]. There is deliberately no tool that answers a question.
    [work_open_view] needs the interface, which does not exist yet: it
    validates its input and reports [opened = false]. *)

val tools : Mcp_kit.Tool.t list
