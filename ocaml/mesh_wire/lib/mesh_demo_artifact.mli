(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A bounded, immutable logical demo artifact. This is content, not a transport
    envelope, an authorization, or a promise that its bytes are safe to execute.
    Decode only after authenticating the sender and recipient at the E2EE layer.
    Local delivery must apply the same target and revision checks. *)

type format = Scene_v0 | Tsx_quickjs_v0

type error =
  | Invalid_revision
  | Invalid_content
  | Invalid_fields
  | Invalid_encoding
  | Invalid_digest
  | Unsupported_version
  | Malformed
  | Too_large
  | Wrong_target
  | Wrong_revision
  | Invalid_target of Mesh_runner_target.error

type t

val max_content_bytes : int
val max_encoded_bytes : int

val create :
  key:Mesh_runner_target.resource_key ->
  revision:int ->
  format:format ->
  content:string ->
  (t, error) result
(** Positive JavaScript-safe revision and at most [max_content_bytes] bytes. The
    caller must separately validate the scene or compiled bundle before
    constructing or executing it; this module only binds and hashes bytes. *)

val key : t -> Mesh_runner_target.resource_key
val revision : t -> int
val format : t -> format
val content : t -> string
val digest : t -> string

val encode : t -> string
(** Canonical v1 JSON with strict base64url content and SHA-256 digest. Device
    identity and anti-replay sequence belong to the authenticated envelope, so
    one logical artifact can be encrypted separately for several clients. *)

val decode :
  expected_key:Mesh_runner_target.resource_key ->
  expected_revision:int ->
  string ->
  (t, error) result
(** Exact fields, bounded input, canonical base64url and matching digest. This
    verifies integrity against accidental or internally inconsistent bytes, not
    provenance: an attacker can change both content and digest. The expected
    key/revision must come from the independently authenticated transport or a
    trusted local request, never from this same JSON. *)
