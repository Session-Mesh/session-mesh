(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Bounded routing metadata and opaque in-process envelopes. Parsing proves
    shape only, never admission, ownership or freshness. *)

type field = Runner_id | Resource_id | Incarnation | Correlation_id

type error =
  | Invalid_identifier of field
  | Metadata_too_large
  | Malformed_metadata
  | Unsupported_version
  | Invalid_fields
  | Payload_too_large

module Runner_id : sig
  type t

  val of_string : string -> (t, error) result
  val to_string : t -> string
end

module Resource_id : sig
  type t

  val of_string : string -> (t, error) result
  val to_string : t -> string
end

module Incarnation : sig
  type t

  val of_string : string -> (t, error) result
  val to_string : t -> string
end

module Correlation_id : sig
  type t

  val of_string : string -> (t, error) result
  val to_string : t -> string
end

type resource_key
(** One resource incarnation on one runner, excluding request correlation. *)

val resource_key :
  runner:Runner_id.t ->
  resource:Resource_id.t ->
  incarnation:Incarnation.t ->
  resource_key

val equal_resource_key : resource_key -> resource_key -> bool
val runner : resource_key -> Runner_id.t
val resource : resource_key -> Resource_id.t
val incarnation : resource_key -> Incarnation.t

type target

val target : resource_key -> Correlation_id.t -> target
val key : target -> resource_key
val correlation : target -> Correlation_id.t
val equal_target : target -> target -> bool

val encode_metadata : target -> string
(** Encode exact v1 fields; opaque payload is never included. *)

val decode_metadata : string -> (target, error) result
(** Exact fields/types/version, bounded before parsing. No authority is issued.
*)

type envelope

val envelope : target -> payload:string -> (envelope, error) result
(** Accept at most [Mesh_wire.max_data_frame] opaque bytes, including empty
    data. *)

val envelope_target : envelope -> target
val payload : envelope -> string
