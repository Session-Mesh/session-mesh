(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Source-only catalog projection over the canonical demo admission record.

    The catalog bytes are exactly [demo-runtime-admission-v1] bytes. This module
    adds no wire schema and grants no authority. Every expectation is supplied
    by the trusted caller, independently of the bytes being decoded. *)

type t
type error = Mesh_demo_runtime_admission.error

val accept :
  expected_target:Mesh_demo_runtime_admission.target ->
  expected_revision:int ->
  expected_digest:string ->
  expected_compiler_profile:Mesh_demo_runtime_admission.compiler_profile ->
  expected_runtime_profile:Mesh_demo_runtime_admission.runtime_profile ->
  string ->
  (t, error) result

val accept_v2 :
  expected_target:Mesh_demo_runtime_admission.target ->
  expected_revision:int ->
  expected_digest:string ->
  expected_schema_digest:string ->
  string ->
  (t, error) result
(** Bound and accept the exact canonical admission bytes. *)

val bytes : t -> string
val admission : t -> Mesh_demo_runtime_admission.t
val target : t -> Mesh_demo_runtime_admission.target
val revision : t -> int
val code_digest : t -> string
val compiler_profile : t -> Mesh_demo_runtime_admission.compiler_profile
val runtime_profile : t -> Mesh_demo_runtime_admission.runtime_profile
val limits : t -> Mesh_demo_runtime_admission.limits
val input_schema_digest : t -> string option
