(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module A = Mesh_demo_runtime_admission
module C = Mesh_demo_runtime_catalog
module T = Mesh_runner_target

let ok = function
  | Ok value -> value
  | Error _ -> Alcotest.fail "unexpected refusal"

let key runner resource incarnation =
  T.resource_key
    ~runner:(ok (T.Runner_id.of_string runner))
    ~resource:(ok (T.Resource_id.of_string resource))
    ~incarnation:(ok (T.Incarnation.of_string incarnation))

let digest = "c52fd3de91e7fadaa0c16cc294324e26889d0f3ffa1e86ca380161851446f5b0"
let base_key = key "runner_a" "resource_1" (String.make 32 'a')
let target = ok (A.target ~key:base_key ~demo_id:"demo_01")
let record = ok (A.create ~target ~revision:3 ~code_digest:digest)

let vector_bytes () =
  let path = Sys.getenv "MESH_DEMO_CATALOG_VECTORS" in
  let json = Yojson.Safe.from_file path in
  match Yojson.Safe.Util.member "canonical" json with
  | `String value -> value
  | _ -> Alcotest.fail "canonical catalog vector missing"

let bytes = vector_bytes ()

let accept ?(expected_target = target) ?(revision = 3)
    ?(expected_digest = digest) candidate =
  C.accept ~expected_target ~expected_revision:revision ~expected_digest
    ~expected_compiler_profile:A.Esbuild_0_25_10_bwrap_v1
    ~expected_runtime_profile:A.Quickjs_emscripten_0_32_0_worker_v1_view_v0
    candidate

let test_exact_projection () =
  Alcotest.(check string)
    "encoder matches shared vector" bytes (A.encode record);
  let catalog = ok (accept bytes) in
  Alcotest.(check string) "same canonical bytes" bytes (C.bytes catalog);
  Alcotest.(check int) "revision" 3 (C.revision catalog);
  Alcotest.(check string) "digest" digest (C.code_digest catalog);
  Alcotest.(check bool) "target" true (A.equal_target target (C.target catalog));
  Alcotest.(check bool) "limits" true (C.limits catalog = A.limits)

let target_for runner resource incarnation demo_id =
  ok (A.target ~key:(key runner resource incarnation) ~demo_id)

let test_external_identity_is_authoritative () =
  let distinct =
    [
      target_for "runner_b" "resource_1" (String.make 32 'a') "demo_01";
      target_for "runner_a" "resource_2" (String.make 32 'a') "demo_01";
      target_for "runner_a" "resource_1" (String.make 32 'b') "demo_01";
      target_for "runner_a" "resource_1" (String.make 32 'a') "demo_02";
    ]
  in
  List.iter
    (fun expected_target ->
      Alcotest.(check bool)
        "homonym/reincarnation refused" true
        (accept ~expected_target bytes = Error A.Wrong_target))
    distinct;
  Alcotest.(check bool)
    "revision refused" true
    (accept ~revision:4 bytes = Error A.Wrong_revision);
  Alcotest.(check bool)
    "digest refused" true
    (accept ~expected_digest:(String.make 64 '0') bytes = Error A.Wrong_digest)

let test_no_second_schema () =
  Alcotest.(check bool)
    "over bound before parse" true
    (accept (String.make (A.max_encoded_bytes + 1) '{') = Error A.Too_large);
  Alcotest.(check bool)
    "unknown title refused" true
    (accept (String.sub bytes 0 (String.length bytes - 1) ^ ",\"title\":\"x\"}")
    = Error A.Invalid_fields);
  Alcotest.(check bool)
    "invalid UTF-8 refused" true
    (accept "\255" = Error A.Malformed)

let test_v2_catalog_independent_identity () =
  let schema_digest = String.make 64 'b' in
  let record =
    ok
      (A.create_v3 ~target ~revision:3 ~code_digest:digest
         ~input_schema_digest:schema_digest)
  in
  let bytes = A.encode record in
  let accept ?(expected_target = target) ?(revision = 3)
      ?(expected_digest = digest) ?(expected_schema_digest = schema_digest) () =
    C.accept_v2 ~expected_target ~expected_revision:revision ~expected_digest
      ~expected_schema_digest bytes
  in
  Alcotest.(check bool) "v2 accepted" true (Result.is_ok (accept ()));
  Alcotest.(check bool)
    "catalog target B refused" true
    (accept
       ~expected_target:
         (target_for "runner_b" "resource_1" (String.make 32 'a') "demo_01")
       ()
    = Error A.Wrong_target);
  Alcotest.(check bool)
    "catalog revision B refused" true
    (accept ~revision:4 () = Error A.Wrong_revision);
  Alcotest.(check bool)
    "catalog code B refused" true
    (accept ~expected_digest:(String.make 64 'c') () = Error A.Wrong_digest);
  Alcotest.(check bool)
    "catalog schema B refused" true
    (accept ~expected_schema_digest:(String.make 64 'c') ()
    = Error A.Wrong_schema_digest)

let () =
  Alcotest.run "demo runtime catalog"
    [
      ( "projection",
        [
          Alcotest.test_case "exact admission bytes" `Quick
            test_exact_projection;
          Alcotest.test_case "external identity" `Quick
            test_external_identity_is_authoritative;
          Alcotest.test_case "no second schema" `Quick test_no_second_schema;
          Alcotest.test_case "v2 independent identity" `Quick
            test_v2_catalog_independent_identity;
        ] );
    ]
