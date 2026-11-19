(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The request of [work-write --request]: one JSON object on standard input,
    [{"op": "answer", "args": {"question": "N-...", "text": "..."}}]. *)

type t = Answer of { question : string; text : string }

val max_bytes : int
(** 12288: 4096 for the envelope plus 8000 bytes, room for an answer of the
    2000-character limit in four-byte UTF-8. A longer request is
    [invalid_input]. *)

val parse : string -> (t, Work_mcp.Work_err.t) result
(** Strict: exactly the fields [op] and [args], each once; [op] is
    [answer]; [args] holds exactly [question] (an [N-] question id) and
    [text], both strings, each once. Anything else is [invalid_input]. The
    text itself is checked by {!Work_mcp.Work_questions.answer_once}. *)
