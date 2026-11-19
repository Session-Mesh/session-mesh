(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Retry keys of the write tools. A client that times out cannot know
    whether a write happened; with an optional [request_id], a second call of
    the same session, the same tool and the same target returns the original
    result with ["duplicate": true] and writes nothing.

    [work_ask] stores the [request_id] on its [question] event
    ({!Work_questions.ask}). For [work_log] and [work_add_task] the worklog
    library takes no extra event field, so a small event of the type
    [request] is written right after the write (fields [tool], [request_id],
    [target] and the original [result]); a crash between the two writes leaves
    a write whose retry is not recognised. [wl] warns about the unknown type
    like it does for [question] and [answer]. *)

val max_length : int
(** 64. *)

val check : string -> (string, Work_err.t) result
(** A [request_id]: 1 to 64 characters among [A-Za-z0-9_.:-]. *)

val of_args : Yojson.Safe.t -> (string option, Work_err.t) result
(** The optional [request_id] argument, checked. *)

val once :
  Mesh_worklog.Ctx.t ->
  tool:string ->
  request_id:string option ->
  session:Mesh_worklog.Session.t option ->
  target:string ->
  task_of:(Yojson.Safe.t -> string) ->
  (unit -> (Yojson.Safe.t, Work_err.t) result) ->
  (Yojson.Safe.t, Work_err.t) result
(** Run the write, unless the same session already wrote with this
    [request_id] on this [target], in which case the original result is
    returned with ["duplicate": true]. Without a [request_id] the write runs
    as is; a [request_id] without a session is [invalid_input]. [task_of]
    names the task id that carries the record, taken from the result. A
    record that cannot be written is a warning, not a failure. *)

val with_duplicate : Yojson.Safe.t -> Yojson.Safe.t
(** The object with ["duplicate": true] added. *)

val event_type : string
(** [request]. *)
