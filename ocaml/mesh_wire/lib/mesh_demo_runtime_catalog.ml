(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module A = Mesh_demo_runtime_admission

type t = { bytes : string; admission : A.t }
type error = A.error

let accept ~expected_target ~expected_revision ~expected_digest
    ~expected_compiler_profile ~expected_runtime_profile bytes =
  Result.map
    (fun admission -> { bytes; admission })
    (A.decode ~expected_target ~expected_revision ~expected_digest
       ~expected_compiler_profile ~expected_runtime_profile bytes)

let accept_v2 ~expected_target ~expected_revision ~expected_digest
    ~expected_schema_digest bytes =
  Result.map
    (fun admission -> { bytes; admission })
    (A.decode_v2 ~expected_target ~expected_revision ~expected_digest
       ~expected_schema_digest
       ~expected_compiler_profile:A.Esbuild_0_25_10_bwrap_v1
       ~expected_runtime_profile:
         A.Quickjs_emscripten_0_32_0_worker_v2_view_v2_input_v1 bytes)

let bytes value = value.bytes
let admission value = value.admission
let target value = A.record_target value.admission
let revision value = A.revision value.admission
let code_digest value = A.code_digest value.admission
let compiler_profile value = A.compiler_profile value.admission
let runtime_profile value = A.runtime_profile value.admission
let limits value = A.record_limits value.admission
let input_schema_digest value = A.input_schema_digest value.admission
