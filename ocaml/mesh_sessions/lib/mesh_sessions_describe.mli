(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The row of one session ([discover.describe]): its working directory, its
    foreground command and its agent, the agent fields coming from the
    adapter registered for the agent's type. No agent type is named here. *)

type t
(** A described row, kept in parts so that an adapter's cross-session
    {!Mesh_agent.ADAPTER.check} can replace its agent fields. *)

val row : Mesh_agent.Registry.t -> Mesh_agent_round.t -> Mesh_agent.session -> t
(** The row of the session whose leader is [session.pid]. Blocks on process
    and file reads: run it in a system thread. An adapter's exception
    propagates. *)

val json : t -> Yojson.Safe.t

val supported : t -> bool
(** [false] when the session runs an agent no adapter is registered for: the
    row then lacks the adapter's fields ([unsupported]). *)

val agent : t -> (string * Mesh_agent.described) option
(** The agent's type and what its adapter described, for a supported agent. *)

val with_fields : t -> Mesh_agent.fields -> t
(** The row with these agent fields in place of the adapter's. *)

val max_cmd : int
(** 160 code points. *)
