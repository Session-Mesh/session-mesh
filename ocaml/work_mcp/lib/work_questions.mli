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
      [by], the identity of the answerer.

    The worklog library ignores unknown event types with a warning, so [wl]
    keeps working and does not display them. The fold of these two types lives
    here only.

    Agents can ask ({!ask}, behind [work_ask]) but no tool of the server
    writes an [answer]: {!answer} is meant for the interface, which calls it
    with the owner's identity. *)

type answer = { answer_text : string; by : string; answered_at : int }

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
    the id; unknown is [Not_found]. Not exposed by any tool: only code that
    links this library can call it. A question can receive several answers;
    all are kept. *)
