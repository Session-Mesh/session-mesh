(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The fields of a [round] or [describe] request (docs/sessions-protocol.md),
    validated. *)

type session = {
  name : string;  (** [[A-Za-z0-9_-]{1,48}], unique in a request. *)
  created : Yojson.Safe.t;  (** A number, echoed as it was received. *)
  pid : int;  (** The session leader, 1 to 2{^31}-1. *)
  activity : float;  (** 0 when absent. *)
  busy : bool;
}

type t = {
  sessions : session list;
  focus : string list;  (** Names of [sessions] only, without repeats. *)
  full : bool;
  avoid : string list;
}

val max_sessions : int
(** 4096. *)

val parse : Mesh_jsonl_rpc_envelope.fields -> (t, string) result
(** The message of an error names the field at fault, never its value. *)

val valid_name : string -> bool

val retain_listed : (string, 'a) Hashtbl.t -> session list -> unit
(** Remove from a table keyed by session name the names these sessions do
    not have. *)

val agent_session : session -> Mesh_agent.session
(** The session as an adapter receives it. *)
