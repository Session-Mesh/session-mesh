(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The Codex adapter: a Codex process described as [discover.codex_info]
    does, its conversation ({!Mesh_agent_codex_identity}) and what its rollout
    says ({!Mesh_agent_codex_fold}): [session_id], [identity_source], and,
    when the rollout is found, [last], [updated], [cwd], [status] ([busy] when
    the rollout was written in the last 20 seconds) and [said]. It only reads.

    {b Once per round} ({!prepare}): the process table's Codex processes are
    read ({!Mesh_agent_codex_view}), the recent rollouts are walked once
    ({!Mesh_agent_codex_rollouts}, headers cached across rounds), the
    conversation of every terminal session whose agent is Codex is resolved,
    and Python's duplicate-id rules run on them ({!Mesh_session_checks}):
    such a duplicate is withdrawn before any row is described. {!describe}
    then folds the rollout, from the previous cursor when it grew
    ({!Mesh_agent_transcripts}). A round whose preparation did not finish
    gives Codex rows without an identity.

    {b The identity registry} is not read yet: {!config.registry_lookup} is
    where it plugs in. A session it answers for takes the registered id with
    no heuristic in {!describe}, and {!check}, after every row of the round,
    applies decision I4 to the ids a registered identity shares. *)

type config = {
  now : unit -> float;  (** Seconds since the epoch ([Unix.gettimeofday]). *)
  boot_time : unit -> float option;
      (** Linux: the boot time ([btime] of [/proc/stat]), from which a process's
          start time is computed; read once. *)
  registry_lookup : Mesh_agent.session -> (string * Mesh_session_checks.registry_source) option;
      (** The registered conversation of a listed session (keyed by its
          [name] and [created]); [fun _ -> None] for now. *)
}

val default_config : config

include Mesh_agent.ADAPTER
(** With {!default_config}. *)

val create_with : config -> Mesh_agent_roots.t -> t

val with_config : config -> (module Mesh_agent.ADAPTER with type t = t)
(** The adapter with this configuration, for {!Mesh_agent.adapter}. *)

type counters = {
  walks : int;  (** Walks of the rollout directories. *)
  headers_read : int;  (** Rollout first lines read from disk. *)
  restarted : int;  (** Rollouts folded from their start (or window). *)
  appended : int;  (** Rollouts read from a previous cursor. *)
  unchanged : int;  (** Rollouts not opened: unchanged since the last read. *)
}

val counters : t -> counters

val window : int
(** 8 MB: the bytes the first read of a rollout covers at most, as Python. *)
