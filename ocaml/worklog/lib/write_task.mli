(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Writing tasks. Every operation takes the repository lock, validates
    against the state read under it, appends its events and commits only the
    files it wrote (message [wl: <cmd> <id>]). Nothing is written when a
    validation fails. [?session] is the agent session on whose behalf the
    write is made. *)

type outcome =
  | Changed
  | Unchanged  (** nothing was written: the value was already there *)

val add :
  Ctx.t ->
  ?session:Session.t ->
  title:string ->
  product:string ->
  ?priority:string ->
  ?status:string ->
  ?due:string ->
  ?tags:string list ->
  ?links:string list ->
  ?project:string ->
  ?track:string ->
  ?owner:string ->
  ?eta:string ->
  ?size:string ->
  ?origin:string ->
  ?also:string list ->
  ?notes:string ->
  unit ->
  (string, Err.t) result
(** Create a task and return its id. Writes [tasks/<product>/T-xxxx[-slug].md]
    (identity-only frontmatter, then the notes) and a [created] event
    ([priority] defaults to [P2], [status] to [todo], both recorded
    explicitly), followed by [set]/[add] events for the other fields.
    [product] and each [also] must be in the taxonomy; [project] is a project
    reference. *)

val set :
  Ctx.t ->
  ?session:Session.t ->
  task:string ->
  field:string ->
  value:string option ->
  unit ->
  (string * outcome, Err.t) result
(** Set a scalar field ([status priority due title product project track owner
    eta size origin]) of a task given by reference; returns the task id.
    [value = None] clears [due project track owner eta size origin] ([owner]
    returns to [me]). [product] is checked against the taxonomy and the event
    carries its category; [project] is a project reference. A value equal to
    the current one writes nothing. *)

val add_item :
  Ctx.t ->
  ?session:Session.t ->
  task:string ->
  field:string ->
  value:string ->
  unit ->
  (string * outcome, Err.t) result
(** Add to a list field ([tags links blocked_by also]). [blocked_by] takes a
    task reference (resolved to the full id, not the task itself); [also] a
    product of the taxonomy. A value already present writes nothing. *)

val remove_item :
  Ctx.t ->
  ?session:Session.t ->
  task:string ->
  field:string ->
  value:string ->
  unit ->
  (string, Err.t) result
(** Remove from a list field; removing an absent value is [Usage]. *)

val log :
  Ctx.t ->
  ?session:Session.t ->
  task:string ->
  ?kind:string ->
  ?date:string ->
  ?prov:string ->
  string ->
  (string, Err.t) result
(** Record text on a task: [kind] is [progress] (default) or one of [decision
    learning risk metric mentoring shipped]. [date] is only for [shipped]
    (default: today, UTC). [prov] is [stated] (omitted from the event),
    [inferred] or [confirmed]. If the session has an id and is not yet linked
    to the task, a [session_linked] event is written first, in the same
    append. Returns the task id. *)

val note :
  Ctx.t -> ?session:Session.t -> task:string -> ?prov:string -> string -> (string, Err.t) result
(** Like {!log} with a [note] event; never links the session. *)

val block :
  Ctx.t ->
  ?session:Session.t ->
  task:string ->
  ?kind:string ->
  ?on:string ->
  string ->
  (string, Err.t) result
(** Open a blocker ([kind]: [external dependency decision tooling review
    other], default [other]); returns the blocker id [B-xxxxxx]. The task's
    status is unchanged. *)

val unblock :
  Ctx.t ->
  ?session:Session.t ->
  task:string ->
  ?blocker:string ->
  ?text:string ->
  unit ->
  (string, Err.t) result
(** Resolve a blocker; returns its id. Without [blocker], the only open one;
    with several open, [Not_found] listing them and nothing written. *)

val link :
  Ctx.t -> ?session:Session.t -> task:string -> unit -> (string * outcome, Err.t) result
(** Link the session to the task. [Usage] without a session id; an already
    linked session writes nothing. *)
