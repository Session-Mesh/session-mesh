(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Rounds: one process table, the adapters prepared once, then every session
    described in the order of service with bounded concurrency and a deadline
    each, each row reported as soon as it ends (docs/sessions-protocol.md,
    [round] and [describe]). The state kept across rounds is the last row sent
    per session (for [same]), the backoff, and the system threads. *)

type config = {
  deadline : float;  (** Seconds per row (2). *)
  concurrency : int;  (** Rows described at a time (8). *)
  max_threads : int;  (** System threads in flight, abandoned ones included (16). *)
  setup_deadline : float;
      (** Seconds for the process table, and for each adapter's preparation (5). *)
}

val config :
  ?deadline:float -> ?concurrency:int -> ?max_threads:int -> ?setup_deadline:float -> unit -> config

type t

val create :
  clock:[> float Eio.Time.clock_ty ] Eio.Std.r ->
  config ->
  Mesh_pty_processes.platform ->
  Mesh_agent.Registry.t ->
  t

val round :
  t ->
  Mesh_sessions_request.t ->
  emit:(string -> Mesh_jsonl_rpc_envelope.fields -> (unit, [ `Too_large | `Not_json ]) result) ->
  Mesh_jsonl_rpc_envelope.fields
(** Emit one [row] event per session, as each ends, and return the fields of
    the final frame. *)

val describe : t -> Mesh_sessions_request.t -> Mesh_jsonl_rpc_envelope.fields
(** The rows, now, in the order of the request; no [same], no backoff. *)
