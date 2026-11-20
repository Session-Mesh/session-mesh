(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [session-questions]: the open questions of each session, by session name,
    for the marker of the session list and of the session header.

    The open questions of a session are, without duplicates, those it asked (the
    [session] of the question), those about a task it is linked to, and those
    about the project of such a task. A question about another task of the same
    project is not counted. Sessions are keyed by name only: two agents that
    used the same session name are one entry, and a name used again by a later
    session carries the earlier one's questions (the data repository does not
    know which sessions are still open).

    Only sessions with at least one open question are listed: at most
    {!max_sessions}, the one with the newest open question first, then by name.
    Each has its count and at most {!max_questions} questions, newest first,
    each [{id, about?, project?}] ([project]: the project the question is about,
    or the project of the task it is about); no question text. *)

val max_sessions : int
(** 500. *)

val max_questions : int
(** 20 per session; the others are counted in [questions_omitted]. *)

val run : Wr_load.t -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
