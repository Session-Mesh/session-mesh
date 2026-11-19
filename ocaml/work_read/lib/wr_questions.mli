(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Non-blocking questions ([question] and [answer] events, folded by
    {!Work_mcp.Work_questions}), read only. *)

val max_questions : int
(** 50 per [task] document. *)

val max_brief_questions : int
(** 20 per summary document ([project], [resume]). *)

val brief_text : int
(** 300: in a summary, the text, the assumption and each answer are cut at
    this many characters (with [...]). *)

val ordered : Work_mcp.Work_questions.question list -> Work_mcp.Work_questions.question list
(** Open questions first, then answered ones, each group newest first (the
    input is in time order). *)

val to_json : brief:bool -> Work_mcp.Work_questions.question -> Yojson.Safe.t
(** {!Work_mcp.Work_render.question_json} (text, options, assumption, asker
    agent and session, the five newest answers), shortened when [brief]. *)

val fields :
  ?brief:bool -> about:string list -> Work_mcp.Work_questions.question list -> (string * Yojson.Safe.t) list
(** [open_questions] (count) and [questions]: those whose [about] is one of
    the ids, in {!ordered} order, at most {!max_questions}, or
    {!max_brief_questions} shortened when [brief]. *)
