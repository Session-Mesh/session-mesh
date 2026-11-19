(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The conversation of one Codex process ([discover._codex_conversation]).
    In order:

    + a registered identity, when the registry has one for the session: its
      id, no heuristic;
    + [open_rollout]: the newest top-level rollout the process holds open
      (exact);
    + [argv_resume]: the id of [codex resume <id>] (where it started), unless
      another Codex may claim it (then none: contested) or its folder shows a
      later conversation (then the guess below);
    + [cwd_unique]: the newest top-level rollout of its folder written since
      it started, when it is the only Codex there and no other Codex holds
      that rollout open.

    When the process's open files cannot be read, it has no identity (as
    Python), unless the registry gives one. *)

type source = Open_rollout | Argv_resume | Cwd_unique | Registry of Mesh_session_checks.registry_source

type t = {
  path : string option;  (** The rollout that describes the conversation, if found. *)
  id : Yojson.Safe.t;  (** A rollout header's id may be any JSON value. *)
  source : source;
  holds_open : bool;  (** The process holds a rollout of this id open. *)
}

type context = {
  view : Mesh_agent_codex_view.t;
  rollouts : Mesh_agent_codex_rollouts.rollout list;  (** This round's walk. *)
  describe_path : string -> Mesh_agent_codex_rollouts.rollout option;
  start_time : Mesh_agent_round.process -> float;  (** Seconds since the epoch; 0 when unknown. *)
}

val source_name : source -> string
(** As the row reports it: [open_rollout], [argv_resume], [cwd_unique], or
    the registry's source name. *)

val check_source : source -> Mesh_session_checks.source

val conversation :
  context -> registered:(string * Mesh_session_checks.registry_source) option -> Mesh_agent_round.process -> t option
