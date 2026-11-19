(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The requests of [mesh-sessions] ([hello], [round], [describe]) over
    {!Mesh_jsonl_rpc} (docs/sessions-protocol.md). *)

val schema : int
(** The version of the row format: 1. *)

val rpc_config : Mesh_jsonl_rpc.config
(** 4 MiB requests, 8 MiB final frames, depth 64, 4 requests in progress. *)

val handler : Mesh_sessions_round.t -> Mesh_agent.Registry.t -> Mesh_jsonl_rpc.handler

val serve :
  clock:[> float Eio.Time.clock_ty ] Eio.Std.r ->
  ?config:Mesh_sessions_round.config ->
  platform:Mesh_pty_processes.platform ->
  Mesh_agent.Registry.t ->
  _ Eio.Flow.source ->
  _ Eio.Flow.sink ->
  unit
(** Answer requests until the end of the input. *)
