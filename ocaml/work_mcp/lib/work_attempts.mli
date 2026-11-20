(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Attempts on a task: an extension of the data format that is ours, not
    [wl]'s, like {!Work_questions}. One event type is added to the log.

    - [attempt]: [task] is the task (a [T-] id) the attempt was on; fields
      [id] ([A-] and eight lowercase hex digits, drawn at random), [outcome]
      ([success], [failure] or [abandoned]), [reason] ([ci_failure],
      [review_nogo], [test_red], [environment], [external] or [other]:
      required on a failure, optional when abandoned, absent on a success),
      optional [text] (one line, at most 500 characters), [links] (at most 5,
      300 characters each), [started] and [ended] (timestamps in the format of
      [ts], with [started] <= [ended] <= [ts]), [ref] (an external identifier
      such as a Roster attempt id, at most 64 characters among
      [A-Za-z0-9_.:-]) and [request_id] (the retry key of the call that wrote
      it), plus the [agent] and [session] of the writer.

    One event is written when a pass of work ends (a failure that will be
    retried, an abandoned pass, the success that follows failures), not for
    every failed command. The attempt number is not stored: it is derived
    from the fold order (the n-th [attempt] event of the task, events ordered
    by time, then host, file and line), so two hosts never collide on it.

    The worklog library ignores unknown event types with a warning, so [wl]
    keeps working and does not display attempts. The fold of this type lives
    here only. A budget of attempts is not part of the format: the readers
    only derive the run of consecutive failures and flag it at
    {!reframe_threshold}. *)

type attempt = {
  id : string;
  task : string;
  n : int;  (** derived: 1 for the first attempt event of the task *)
  outcome : string;
  reason : string option;
  text : string option;
  links : string list;
  started : int option;
  ended : int option;
  ref_ : string option;  (** the [ref] field *)
  agent : string option;
  session : string option;
  request_id : string option;
  at : int;  (** the event's [ts] *)
}

type summary = {
  total : int;
  failures : int;
  consecutive_failures : int;
      (** failures since the last success; an abandoned pass neither counts
          nor resets the run *)
  last : attempt option;
}

val event_type : string
(** ["attempt"]. *)

val outcomes : string list
(** [success], [failure], [abandoned]. *)

val reasons : string list
(** [ci_failure], [review_nogo], [test_red], [environment], [external],
    [other]. *)

val max_text : int
(** 500. *)

val max_links : int
(** 5. *)

val max_link : int
(** 300. *)

val max_ref : int
(** 64. *)

val reframe_threshold : int
(** 3: the run of consecutive failures at which a reader flags the task (the
    threshold of Roster's recovery check). *)

val valid_id : string -> bool

val of_events : Mesh_worklog.Event.t list -> attempt list
(** The attempt events (any other event is skipped) in fold order, numbered
    per task. Malformed events and repeated ids are skipped. *)

val of_events_report : Mesh_worklog.Event.t list -> attempt list * string list
(** {!of_events} with a warning for every attempt event that cannot be read
    and for every id that two attempt events use (the first is kept). *)

val load_report : Mesh_worklog.Ctx.t -> (attempt list * string list, Work_err.t) result
(** Read the repository and fold it, with the warnings of {!of_events_report}. *)

val of_task : string -> attempt list -> attempt list
(** The attempts of one task, oldest first. *)

val summary : attempt list -> summary
(** The summary of one task's attempts (as returned by {!of_task}). *)

val needs_reframe : summary -> bool
(** [consecutive_failures >= reframe_threshold]. *)

val is_noise : string -> bool
(** A read warning that only reports an [attempt] event as unknown to the
    library. *)

type recorded = { attempt_id : string; number : int; duplicate : bool; task_summary : summary }

val record :
  Mesh_worklog.Ctx.t ->
  ?session:Mesh_worklog.Session.t ->
  task:string ->
  outcome:string ->
  ?reason:string ->
  ?text:string ->
  ?links:string list ->
  ?started:string ->
  ?ended:string ->
  ?ref_:string ->
  ?request_id:string ->
  unit ->
  (recorded, Mesh_worklog.Err.t) result
(** Record the end of an attempt on a task (a reference, resolved to the full
    id; an unknown task or a project is refused) and return its id, its
    derived number and the task's summary after the write. Every rule is
    checked here, not only by the tool's schema: [Usage] for an unknown
    outcome or reason, a failure without a reason, a success with one, a text
    or link that is blank, too long, on several lines or holds a control,
    invisible or bidirectional character, more than {!max_links} links, a
    timestamp that does not parse, [started] after [ended], either after the
    write's own time, or a [ref] or [request_id] outside its alphabet.
    Nothing is written when a check fails. With a [request_id], an attempt of
    the same session with the same [request_id] on the same task that
    already exists is returned with [duplicate = true] and nothing is
    written. *)
