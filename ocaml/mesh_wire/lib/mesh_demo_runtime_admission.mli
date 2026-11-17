(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Closed, bounded admission metadata for the test-only TSX demo runtime.

    A value binds one immutable demo revision to the exact compiler, runtime,
    view protocol and resource limits reviewed for that revision. It is not an
    authorization, capability grant, recipient envelope, transport message or
    proof of publisher identity. Callers must obtain every [expected_*] argument
    independently of the bytes being decoded. *)

type compiler_profile = Esbuild_0_25_10_bwrap_v1

type runtime_profile =
  | Quickjs_emscripten_0_32_0_worker_v1_view_v0
  | Quickjs_emscripten_0_32_0_worker_v1_view_v2
  | Quickjs_emscripten_0_32_0_worker_v2_view_v2_input_v1

type limits = private {
  code_bytes : int;
  frame_time_ms : int;
  output_bytes : int;
  text_bytes : int;
  nodes : int;
  depth : int;
  update_interval_ms : int;
}

type target

type error =
  | Invalid_demo_id
  | Invalid_revision
  | Invalid_digest
  | Invalid_fields
  | Invalid_limits
  | Unsupported_version
  | Malformed
  | Too_large
  | Wrong_target
  | Wrong_revision
  | Wrong_digest
  | Wrong_compiler_profile
  | Wrong_runtime_profile
  | Wrong_schema_digest

type t

val max_encoded_bytes : int
val limits : limits

val target :
  key:Mesh_runner_target.resource_key ->
  demo_id:string ->
  (target, error) result
(** [demo_id] is an opaque identifier of 1--64 ASCII letters, digits, [_] or
    [-]. It is not a title or a session name. *)

val key : target -> Mesh_runner_target.resource_key
val demo_id : target -> string
val equal_target : target -> target -> bool

val create :
  target:target -> revision:int -> code_digest:string -> (t, error) result
(** Create a record for the sole admitted v1 format and profiles. The digest is
    lowercase SHA-256 hex over the exact compiled code bytes. *)

val create_v2 :
  target:target -> revision:int -> code_digest:string -> (t, error) result
(** Create an explicit v2 record. It is distinct from, and does not reinterpret,
    the historical v1/view-v0 profile. *)

val create_v3 :
  target:target ->
  revision:int ->
  code_digest:string ->
  input_schema_digest:string ->
  (t, error) result

val input_schema_digest : t -> string option
val record_target : t -> target
val revision : t -> int
val code_digest : t -> string
val compiler_profile : t -> compiler_profile
val runtime_profile : t -> runtime_profile
val record_limits : t -> limits

val encode : t -> string
(** Canonical ASCII JSON in a fixed field order. *)

val decode :
  expected_target:target ->
  expected_revision:int ->
  expected_digest:string ->
  expected_compiler_profile:compiler_profile ->
  expected_runtime_profile:runtime_profile ->
  string ->
  (t, error) result
(** Decode only exact canonical v1 bytes, after bounding them before parsing.
    Successful decoding proves agreement with the independently supplied
    expectations; the record itself grants no execution authority. *)

val decode_v2 :
  expected_target:target ->
  expected_revision:int ->
  expected_digest:string ->
  expected_schema_digest:string ->
  expected_compiler_profile:compiler_profile ->
  expected_runtime_profile:runtime_profile ->
  string ->
  (t, error) result
(** Decode only admission-format-v2 bytes. The schema digest expectation is
    independent of the record and a mismatch is reported distinctly. *)
