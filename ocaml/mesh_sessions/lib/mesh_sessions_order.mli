(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Which sessions a round describes first, and which it leaves alone for a
    while (docs/sessions-protocol.md, "Order of service" and "Deadlines"). *)

val service : Mesh_sessions_request.t -> Mesh_sessions_request.session list
(** The [focus] names in their order, then the [busy] sessions, then the
    others; within each group by decreasing [activity], then in the order of
    the request ({!Mesh_priority}). *)

(** A session slow three rounds in a row is left out for three rounds, then
    tried again; a ready description clears its count. Keyed by name; a
    session whose [created] changed starts afresh. *)
module Backoff : sig
  type t

  val create : unit -> t

  val avoid : t -> Mesh_sessions_request.session list -> string list -> unit
  (** Treat these names as already slow three times (a previous run's
      [degraded.avoid]). *)

  val admit : t -> Mesh_sessions_request.session -> bool
  (** Whether to describe the session this round. [false] counts one of the
      rounds it waits. *)

  val ready : t -> Mesh_sessions_request.session -> unit

  val slow : t -> Mesh_sessions_request.session -> [ `Slow | `Backoff ]
  (** Count a slow round: [`Backoff] at the third in a row, which starts the
      wait. *)

  val retain : t -> Mesh_sessions_request.session list -> unit
  (** Forget the sessions no longer listed. *)
end
