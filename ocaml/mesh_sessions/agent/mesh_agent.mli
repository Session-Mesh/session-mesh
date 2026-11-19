(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The interface every agent adapter implements, and the registry that maps
    an agent type to its adapter.

    An adapter knows one agent's files: where its conversations are, how to
    read its state and its last messages. It knows neither the protocol nor
    the order in which sessions are described. Agent detection (which process
    is which agent) is shared ({!Mesh_agent_session}); an adapter is asked to
    describe a process already detected as its type. *)

type fields = (string * Yojson.Safe.t) list
(** The agent fields of a row, beside the [type], [pid], [argv] and
    [foreground] that the round adds for every agent. *)

module type ADAPTER = sig
  type t
  (** The adapter's state across rounds (its caches). *)

  val kind : string
  (** The agent type, one of {!Mesh_agent_session.agent_types}. *)

  val create : Mesh_agent_roots.t -> t

  val prepare : t -> Mesh_agent_round.t -> unit
  (** Called once at the start of each round, before any {!describe} of that
      round, in a system thread: the place for work that every session of
      this agent shares (one walk of a directory of conversations). *)

  val resize : t -> sessions:int -> unit
  (** Bound the caches for this many listed sessions (twice as many entries,
      so that a session that leaves and comes back stays cached). *)

  val describe : t -> Mesh_agent_round.t -> Mesh_agent_round.process -> fields
  (** Describe one agent process. Called from several system threads at once:
      the adapter guards its own state. It blocks on file reads; the caller
      bounds it with a deadline. It never raises on a malformed or unreadable
      file: what cannot be read is left out. *)
end

type adapter

val adapter : (module ADAPTER with type t = 'state) -> Mesh_agent_roots.t -> adapter
(** An adapter with its state, created with these roots. *)

val kind : adapter -> string
val prepare : adapter -> Mesh_agent_round.t -> unit
val resize : adapter -> sessions:int -> unit
val describe : adapter -> Mesh_agent_round.t -> Mesh_agent_round.process -> fields

module Registry : sig
  type t

  val create : adapter list -> t
  (** @raise Invalid_argument if two adapters have the same type, or a type
      that {!Mesh_agent_session.agent_types} does not know. *)

  val find : t -> string -> adapter option
  val kinds : t -> string list
  (** In the order given to {!create}. *)

  val adapters : t -> adapter list
end
