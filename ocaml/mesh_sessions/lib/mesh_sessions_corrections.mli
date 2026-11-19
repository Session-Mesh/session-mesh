(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The adapters' cross-session checks ({!Mesh_agent.ADAPTER.check}) and the
    corrections they made, remembered across rounds.

    A round sends each row as soon as it ends, before the check, which needs
    every row. So that a corrected session is not sent wrong then corrected
    in every round, its last correction is remembered by session name with
    the session's [created], as a patch: the keys the check changed, each
    with its value before and after. The next rounds apply it to the first
    event while [created] is unchanged and every one of those keys still
    holds its value before, however the rest of the row changed (a busy
    session's [updated] or [said]); the check then confirms it (no second
    event) or not (a second event, and the patch is forgotten). *)

type t
(** The last correction of each session. *)

val digest : Mesh_sessions_describe.t -> Digest.t
(** The digest of a row's JSON text. *)

val create : unit -> t

val remembered : t -> Mesh_sessions_request.session -> Mesh_sessions_describe.t -> Mesh_sessions_describe.t
(** The row with the session's last correction applied, when the session
    has the same [created] and each key that correction changed still holds
    its value before; else the row. *)

type outcome = {
  session : Mesh_sessions_request.session;
  described : Mesh_sessions_describe.t;  (** As the adapter described it. *)
  correction : Mesh_agent.fields option;  (** The fields the check gave, if it corrected the row. *)
}

val final : outcome -> Mesh_sessions_describe.t
(** The row after the check: the described row with the keys the check
    changed replaced in place (keys it added come last, keys it removed are
    dropped), so that it equals the row a remembered correction gives. *)

val check :
  run:((unit -> (string * Mesh_agent.fields) list) -> (string * Mesh_agent.fields) list option) ->
  Mesh_agent.adapter list ->
  Mesh_agent_round.t ->
  ?context:(Mesh_sessions_request.session * Mesh_sessions_describe.t) list ->
  (Mesh_sessions_request.session * Mesh_sessions_describe.t) list ->
  outcome list
(** Run each adapter's check over the rows of its type, as described, with
    the [context] rows of its type whose names the rows do not have (the
    rows of an earlier round, for a request that lists a few sessions).
    [run] runs a check and gives [None] when it raised or did not finish.
    Returns an outcome for each row whose adapter's check ran, context rows
    excluded. *)

val remember : t -> outcome list -> unit
(** Keep the corrections of these outcomes, and forget those of the
    sessions they left uncorrected. *)

val retain : t -> Mesh_sessions_request.session list -> unit
(** Forget the sessions not listed. *)
