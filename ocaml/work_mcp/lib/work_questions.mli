(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Non-blocking questions: an extension of the data format that is ours, not
    [wl]'s. Two event types are added to the log.

    - [question]: [task] is the task or project the question is about, or the
      question id itself when it is about none; fields [id] ([N-] and eight
      lowercase hex digits, drawn at random; the six-digit ids of the first version
      are still read; [Q-] belongs to [wl]'s proposals), [text] (at most
      2000 characters), optional [options] (at most 8 labels of at most 100
      characters) and [assumption] (at most 1000 characters), plus the
      [agent] and [session] of the asker.
    - [answer]: same [task] as its question; fields [question], [text] and
      [by], the identity of the answerer, plus the [agent] and [session] of
      the process that wrote it when it has one (an agent relaying the
      owner's words).

    The worklog library ignores unknown event types with a warning, so [wl]
    keeps working and does not display them. The fold of these two types lives
    here only.

    Agents ask with {!ask} (behind [work_ask]). {!answer_once} records one
    answer; it decides nothing about who may answer: that is the caller's
    concern. [work_answer] calls it to relay the owner's words given in an
    agent session's conversation; an owner-only writer of the interface is meant to call
    the same function. *)

type answer = {
  answer_text : string;
  by : string;
  answered_at : int;
  relay_agent : string option;  (** [agent] of the answer event, if any *)
  relay_session : string option;  (** [session] of the answer event, if any *)
}

type question = {
  id : string;
  text : string;
  options : string list;
  assumption : string option;
  about : string option;  (** task or project id, when there is one *)
  event_task : string;  (** the [task] field of the events of this question *)
  agent : string option;
  session : string option;
  request_id : string option;  (** the retry key of the call that wrote it *)
  asked_at : int;
  answers : answer list;  (** oldest first *)
}

val max_text : int
(** 2000. *)

val max_assumption : int
(** 1000. *)

val max_options : int
(** 8. *)

val max_option : int
(** 100. *)

val valid_id : string -> bool
val is_ours : string -> bool
(** Whether an event type is [question] or [answer]. *)

val of_events : Mesh_worklog.Event.t list -> question list
(** Fold the question and answer events (any other event is skipped), oldest
    question first. The first event of an id defines a question; an answer to
    an unknown question and malformed events are ignored. *)

val is_open : question -> bool
(** No answer yet. *)

val load : Mesh_worklog.Ctx.t -> (question list, Work_err.t) result
(** Read the repository and fold it. *)

val load_report : Mesh_worklog.Ctx.t -> (question list * string list, Work_err.t) result
(** Like {!load}, with a warning for every question id that two question events
    use (ids drawn on two hosts can collide after a merge: the first event
    defines the question, the other is ignored) and for every question event
    that cannot be read (no text, or an id that is not [N-] and eight
    lowercase hex digits). *)

val of_events_report : Mesh_worklog.Event.t list -> question list * string list
(** {!of_events} with the collision warnings of {!load_report}. *)

val is_noise : string -> bool
(** A read warning that only reports one of these events as unknown to the
    library; the server does not pass them on. *)

val ask :
  Mesh_worklog.Ctx.t ->
  ?session:Mesh_worklog.Session.t ->
  text:string ->
  ?options:string list ->
  ?assumption:string ->
  ?about:string ->
  ?request_id:string ->
  unit ->
  (string * bool, Mesh_worklog.Err.t) result
(** Record a question and return its id and whether it was a duplicate.
    [about] is a task or project reference, resolved to the full id; unknown is
    [Not_found]. Nothing is written when a validation fails. With a
    [request_id] (stored on the event), a question of the same session, the
    same [request_id] and the same [about] that already exists is returned
    with [true] and nothing is written. *)

val answer :
  Mesh_worklog.Ctx.t ->
  question:string ->
  text:string ->
  by:string ->
  unit ->
  (string, Mesh_worklog.Err.t) result
(** Record an answer ([text] at most 2000 characters, [by] a single-line label
    of at most 100 characters) to the question with this exact id and return
    the id; unknown is [Not_found]. A question can receive several answers
    this way; all are kept. Used by the tests to seed data; writers that face
    a person or an agent use {!answer_once}. *)

type recorded =
  | Recorded of string  (** the answer was written; the question id *)
  | Same_answer of string
      (** the question already has an answer with the same text and [by]:
          nothing was written (a retried call) *)
  | Already_answered of string
      (** the question has another answer: nothing was written *)

val answer_once :
  Mesh_worklog.Ctx.t ->
  ?session:Mesh_worklog.Session.t ->
  question:string ->
  text:string ->
  by:string ->
  unit ->
  (recorded, Mesh_worklog.Err.t) result
(** Record the first answer to the question with this exact id. The same
    validation as {!answer} ([Usage] for a bad text or [by], [Not_found] for
    an unknown id). The lookup and the write happen under the repository
    lock, so of two concurrent writers exactly one records an answer. With a
    [session], its [agent] and [session] are stored on the event (who relayed
    the answer, not who gave it). No authority check: the caller decides who
    may answer. The checks do not rely on the MCP schema: a [text] over 2000
    characters, a control, invisible or bidirectional character in [text] or
    [by] are [Usage] here too. An answer is never replaced or retracted; a
    later owner-only writer will need a way to supersede a relayed one. *)
