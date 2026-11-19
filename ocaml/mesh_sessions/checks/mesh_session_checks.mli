(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The checks between the sessions of one round, run after every identity of
    the round is known and before any row is sent: a conversation id that
    several sessions report is kept by at most one of them.

    Two rule sets, both pure:

    - {b Without a registered identity} in the group, the rules of the Python
      listing ([discover.drop_duplicate_guessed_ids]): a guessed id loses to an
      exact one, two guesses of one id are both dropped, an id read from launch
      arguments is dropped with every session that shares it, and observed ids
      that collide only with each other are kept.
    - {b With a registered identity} (the identity registry, decision I4): the
      current holder keeps the id. The strongest source wins ([Chosen], then
      [Hook], then an observation, registered or live); a tie is broken by
      holding the conversation's file open. The other sessions with an exact
      claim are [Contested]; launch and guessed claims are dropped. A tie that
      holding the file does not break leaves every tied session [Contested].

    These rules only take ids away; they never give one. *)

type registry_source =
  | Chosen  (** Set by the mesh when it launched the agent on that id. *)
  | Hook  (** Reported by the agent's hook. *)
  | Observed  (** Recorded from an earlier observation. *)

type source =
  | Registry of registry_source
  | Open  (** Observed now: the agent holds the conversation's file open. *)
  | Launch  (** Read from the launch arguments: where it started, maybe stale. *)
  | Guessed  (** Inferred (the one agent of its folder). *)

type session = { sid : int; agent_pid : int }
(** A terminal session (its session id, the leader's pid) and its agent. *)

type 'key claim = { key : 'key; id : string; source : source; holds_open : bool }
(** [holds_open]: the agent holds the conversation's file open. *)

type verdict =
  | Keep
  | Drop  (** The id is withdrawn (Python's rule): no id, no source. *)
  | Contested  (** Another session holds this id: no id, source [contested]. *)

val check : 'key claim list -> ('key * verdict) list
(** One verdict per claim, in the order given. *)

val registry_source_name : registry_source -> string
(** ["chosen"], ["hook"], ["observed"]. *)
