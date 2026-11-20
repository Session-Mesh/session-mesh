(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The request of [work-write --request]: one JSON object on standard input,
    [{"op": "answer", "args": {"question": "N-...", "text": "...", "edit":
    true, "choices": ["..."]}}] ([edit] and [choices] optional). *)

type t = Answer of { question : string; text : string; edit : bool; choices : string list }

val max_bytes : int
(** 16384, the web server's bound: 4096 for the envelope, 8000 bytes for an
    answer of the 2000-character limit in four-byte UTF-8, and 3200 for 8
    choices of 100 such characters. A longer request is [invalid_input]. *)

val parse : string -> (t, Work_mcp.Work_err.t) result
(** Strict: exactly the fields [op] and [args], each once; [op] is
    [answer]; [args] holds [question] (an [N-] question id) and [text], both
    strings, and optionally [edit] (a boolean, default false) and [choices]
    (at most 8 strings), each once, and nothing else. Anything else is
    [invalid_input]. The text and the choices themselves are checked by
    {!Work_mcp.Work_questions.answer_once}. *)
