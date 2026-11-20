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
      characters, distinct), optional [kind] (see {!kind}) and [assumption]
      (at most 1000 characters), plus the
      [agent] and [session] of the asker.
    - [answer]: same [task] as its question; fields [question], [text] and
      [by], the identity of the answerer, plus the [agent] and [session] of
      the process that wrote it when it has one (an agent relaying the
      owner's words). The owner-authenticated writer ([work-write], behind
      the web server's owner sign-in) writes no [agent] and no [session],
      [by] = [owner] and [via] = [owner-web] instead, and the options the
      owner picked in [choices] when there are any.

    The worklog library ignores unknown event types with a warning, so [wl]
    keeps working and does not display them. The fold of these two types lives
    here only.

    Agents ask with {!ask} (behind [work_ask]). {!answer_once} records one
    answer; it decides nothing about who may answer: that is the caller's
    concern. [work_answer] calls it to relay the owner's words given in an
    agent session's conversation; the owner-only writer [work-write] calls
    it with [~owner_web:true]. *)

type answer = {
  answer_text : string;
  by : string;
  answered_at : int;
  relay_agent : string option;  (** [agent] of the answer event, if any *)
  relay_session : string option;  (** [session] of the answer event, if any *)
  owner_web : bool;
      (** written by the owner-authenticated writer: [via] is {!owner_web_via},
          [by] is {!owner_by}, and the event has no [agent] and no [session].
          A provenance marker in the log, not a signature: a process of the
          same user that writes the log directly can forge it. *)
  choices : string list;
      (** the options the owner picked, by their text ([choices] of the
          event; empty for a free-text answer and for relayed answers) *)
}

(** How the owner answers: one option ([Single]), any number of options
    ([Multi]), free text only ([Text]), or yes / no ([Yes_no]). Free text
    stays possible for every kind. *)
type kind = Single | Multi | Text | Yes_no

type question = {
  id : string;
  text : string;
  options : string list;
  kind : kind;
      (** the effective kind: the stored [kind] when it is known and fits the
          options, else [Single] with options and [Text] without *)
  assumption : string option;
  about : string option;  (** task or project id, when there is one *)
  event_task : string;  (** the [task] field of the events of this question *)
  agent : string option;
  session : string option;
  request_id : string option;  (** the retry key of the call that wrote it *)
  asked_at : int;
  answers : answer list;  (** oldest first *)
}

val owner_by : string
(** ["owner"]. *)

val owner_web_via : string
(** ["owner-web"], the [via] of an owner-authenticated answer. *)

val max_text : int
(** 2000. *)

val max_assumption : int
(** 1000. *)

val max_options : int
(** 8. *)

val max_option : int
(** 100. *)

val kind_names : string list
(** ["single"; "multi"; "text"; "yes_no"]. *)

val string_of_kind : kind -> string

val yes_no_choices : string list
(** ["yes"; "no"]: the choices of a [Yes_no] question. *)

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
  ?kind:string ->
  ?assumption:string ->
  ?about:string ->
  ?request_id:string ->
  unit ->
  (string * bool, Mesh_worklog.Err.t) result
(** Record a question and return its id and whether it was a duplicate.
    Options are distinct. [kind] is one of {!kind_names}, stored only when
    given: [single] and [multi] need options, [text] and [yes_no] take none
    ([Usage] otherwise).
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
  ?owner_web:bool ->
  ?edit:bool ->
  ?choices:string list ->
  question:string ->
  text:string ->
  by:string ->
  unit ->
  (recorded, Mesh_worklog.Err.t) result
(** Record an answer to the question with this exact id. The same
    validation as {!answer} ([Usage] for a bad text or [by], [Not_found] for
    an unknown id). The lookup and the write happen under the repository
    lock, so of two concurrent writers exactly one records an answer. No
    authority check: the caller decides who may answer. The checks do not
    rely on the MCP schema: a [text] over 2000 characters, a control,
    invisible or bidirectional character in [text] or [by] are [Usage] here
    too.

    Relayed (the default): the first answer wins. With a [session], its
    [agent] and [session] are stored on the event (who relayed the answer,
    not who gave it). An answer already there with the same text and [by] is
    [Same_answer]; any other answer, relayed or owner-authenticated, makes
    it [Already_answered].

    [~owner_web:true], for the owner-authenticated writer only: [by] must be
    {!owner_by} and no [session] is given ([Usage] otherwise); the event gets
    [via] = {!owner_web_via}. Only earlier owner-authenticated answers count:
    one with the same text is [Same_answer], another is [Already_answered].
    Relayed answers do not block it: the owner's answer supersedes them. They
    stay in the log, unchanged; the readers mark them as superseded.

    [~edit:true] (owner-authenticated only): the owner corrects the answer.
    Only the latest owner-authenticated answer counts: the same text is
    [Same_answer], another is appended ([Recorded]) and the earlier one stays
    in the log, marked superseded by the readers.

    [choices] (owner-authenticated only): the options picked, stored on the
    event. Each is an option of the question ([yes] or [no] for a [Yes_no]
    one), none twice, at most 8, at most one unless the kind is [Multi], and
    none for a [Text] question ([Usage] otherwise). [edit] or [choices] on
    the relayed path is [Usage]. *)
