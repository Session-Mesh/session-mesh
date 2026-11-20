(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [open-questions]: every open question of the tracker, oldest first, a page
    at a time, for the list of the Projects view's entry screen.

    [open_questions] counts every open question. [questions] holds at most
    [limit] of them, the oldest first, those asked after the question [after]
    when it is given (the last one of the previous page; it may have been
    answered since), each in full (text and assumption are not shortened) with
    its [context] ({!Wr_question_context}). [questions_omitted] counts the open
    questions after the last one given: the next page starts there. *)

val default_limit : int
(** 20. *)

val max_limit : int
(** 100. *)

val run : Wr_load.t -> after:string option -> limit:int -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
(** [not_found] when [after] is no question of the tracker. *)
