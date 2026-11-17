(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module A = Mesh_demo_runtime_admission
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
let base_target = ok (A.target ~key:base_key ~demo_id:"demo_01")

let sample () =
  ok (A.create ~target:base_target ~revision:3 ~code_digest:digest)

let decode_for ?(target = base_target) ?(revision = 3)
    ?(expected_digest = digest) ?(compiler = A.Esbuild_0_25_10_bwrap_v1)
    ?(runtime = A.Quickjs_emscripten_0_32_0_worker_v1_view_v0) bytes =
  A.decode ~expected_target:target ~expected_revision:revision ~expected_digest
    ~expected_compiler_profile:compiler ~expected_runtime_profile:runtime bytes

let fields bytes =
  match Yojson.Safe.from_string bytes with
  | `Assoc fields -> fields
  | _ -> Alcotest.fail "expected object"

let replace field value fields =
  List.map
    (fun (name, old) -> if name = field then (name, value) else (name, old))
    fields

let wire fields = Yojson.Safe.to_string (`Assoc fields)

let vector () =
  let path = Sys.getenv "MESH_DEMO_ADMISSION_VECTORS" in
  match Yojson.Safe.from_file path with
  | `Assoc fields -> begin
      match List.assoc "canonical" fields with
      | `String value -> value
      | _ -> Alcotest.fail "invalid canonical vector"
    end
  | _ -> Alcotest.fail "invalid vector document"

let check_refused label expected actual =
  Alcotest.(check bool) label true (actual = Error expected)

let test_shared_vector () =
  let encoded = A.encode (sample ()) in
  Alcotest.(check string) "OCaml owns canonical bytes" (vector ()) encoded;
  let decoded = ok (decode_for encoded) in
  Alcotest.(check int) "revision" 3 (A.revision decoded);
  Alcotest.(check string) "digest" digest (A.code_digest decoded);
  Alcotest.(check string)
    "demo id" "demo_01"
    (A.demo_id (A.record_target decoded));
  Alcotest.(check bool) "canonical round trip" true (A.encode decoded = encoded)

let test_closed_canonical_shape () =
  let canonical = A.encode (sample ()) in
  let f = fields canonical in
  check_refused "extra" A.Invalid_fields
    (decode_for (wire (f @ [ ("title", `String "same name") ])));
  check_refused "capability" A.Invalid_fields
    (decode_for (wire (f @ [ ("capabilities", `List []) ])));
  check_refused "recipient" A.Invalid_fields
    (decode_for (wire (f @ [ ("recipient", `String "device") ])));
  check_refused "duplicate" A.Invalid_fields
    (decode_for (wire (("demo_id", `String "other") :: f)));
  check_refused "missing" A.Invalid_fields
    (decode_for (wire (List.remove_assoc "format" f)));
  check_refused "wrong type" A.Invalid_fields
    (decode_for (wire (replace "revision" (`String "3") f)));
  check_refused "format" A.Invalid_fields
    (decode_for (wire (replace "format" (`String "mesh-scene-v0") f)));
  List.iter
    (fun version ->
      check_refused "version" A.Unsupported_version
        (decode_for (wire (replace "version" version f))))
    [ `Int 0; `Int 2 ];
  check_refused "version type" A.Unsupported_version
    (decode_for (wire (replace "version" (`String "1") f)));
  check_refused "whitespace is not canonical" A.Invalid_fields
    (decode_for (" " ^ canonical));
  check_refused "changed order is not canonical" A.Invalid_fields
    (decode_for (wire (List.rev f)));
  let exponent =
    Str.replace_first
      (Str.regexp_string "\"revision\":3")
      "\"revision\":3e0" canonical
  in
  check_refused "exponent is not canonical" A.Invalid_fields
    (decode_for exponent);
  let escaped =
    Str.replace_first (Str.regexp_string "runner_a") "runner_\\u0061" canonical
  in
  check_refused "escaped ASCII is not canonical" A.Invalid_fields
    (decode_for escaped)

let test_independent_expectations () =
  let canonical = A.encode (sample ()) in
  let other_runner =
    ok
      (A.target
         ~key:(key "runner_b" "resource_1" (String.make 32 'a'))
         ~demo_id:"demo_01")
  in
  let other_resource =
    ok
      (A.target
         ~key:(key "runner_a" "resource_2" (String.make 32 'a'))
         ~demo_id:"demo_01")
  in
  let old_incarnation =
    ok
      (A.target
         ~key:(key "runner_a" "resource_1" (String.make 32 'b'))
         ~demo_id:"demo_01")
  in
  let homonymous_demo = ok (A.target ~key:base_key ~demo_id:"demo_02") in
  List.iter
    (fun target ->
      check_refused "wrong exact target" A.Wrong_target
        (decode_for ~target canonical))
    [ other_runner; other_resource; old_incarnation; homonymous_demo ];
  check_refused "wrong revision" A.Wrong_revision
    (decode_for ~revision:2 canonical);
  check_refused "wrong independently pinned digest" A.Wrong_digest
    (decode_for ~expected_digest:(String.make 64 '0') canonical);
  check_refused "invalid expected digest" A.Invalid_digest
    (decode_for ~expected_digest:(String.make 64 'A') canonical)

let mutate_limit name value canonical =
  let f = fields canonical in
  let limits =
    match List.assoc "limits" f with
    | `Assoc values -> `Assoc (replace name (`Int value) values)
    | _ -> Alcotest.fail "limits object expected"
  in
  wire (replace "limits" limits f)

let test_profiles_limits_and_bounds () =
  let canonical = A.encode (sample ()) in
  let f = fields canonical in
  check_refused "compiler substitution" A.Wrong_compiler_profile
    (decode_for
       (wire
          (replace "compiler_profile" (`String "esbuild-0.25.11-bwrap-v1") f)));
  check_refused "runtime substitution" A.Wrong_runtime_profile
    (decode_for
       (wire
          (replace "runtime_profile"
             (`String "quickjs-emscripten-0.33.0+worker-v1+view-v0") f)));
  let quota_cases =
    [
      ("code_bytes", 131_072);
      ("frame_time_ms", 60_000);
      ("output_bytes", 65_536);
      ("text_bytes", 2_000);
      ("nodes", 100);
      ("depth", 6);
      ("update_interval_ms", 100);
    ]
  in
  List.iter
    (fun (name, exact) ->
      check_refused (name ^ " +1") A.Invalid_limits
        (decode_for (mutate_limit name (exact + 1) canonical)))
    quota_cases;
  let limit_fields =
    match List.assoc "limits" f with
    | `Assoc values -> values
    | _ -> Alcotest.fail "limits object expected"
  in
  check_refused "extra limit" A.Invalid_limits
    (decode_for
       (wire (replace "limits" (`Assoc (("memory", `Int 1) :: limit_fields)) f)));
  check_refused "duplicate limit" A.Invalid_limits
    (decode_for
       (wire
          (replace "limits" (`Assoc (("nodes", `Int 100) :: limit_fields)) f)));
  check_refused "bounded before parse" A.Too_large
    (decode_for (String.make (A.max_encoded_bytes + 1) '{'));
  check_refused "malformed" A.Malformed (decode_for "{");
  Alcotest.(check bool)
    "demo id exact bound" true
    (Result.is_ok (A.target ~key:base_key ~demo_id:(String.make 64 'a')));
  check_refused "demo id +1" A.Invalid_demo_id
    (A.target ~key:base_key ~demo_id:(String.make 65 'a'));
  check_refused "demo id is opaque ASCII" A.Invalid_demo_id
    (A.target ~key:base_key ~demo_id:"démo");
  Alcotest.(check bool)
    "safe revision boundary" true
    (Result.is_ok
       (A.create ~target:base_target ~revision:9_007_199_254_740_991
          ~code_digest:digest));
  check_refused "unsafe revision" A.Invalid_revision
    (A.create ~target:base_target ~revision:9_007_199_254_740_992
       ~code_digest:digest);
  check_refused "uppercase digest" A.Invalid_digest
    (A.create ~target:base_target ~revision:1 ~code_digest:(String.make 64 'A'))

let test_v2_is_explicit_and_does_not_reinterpret_v1 () =
  let legacy = A.encode (sample ()) in
  let v2 =
    ok (A.create_v2 ~target:base_target ~revision:3 ~code_digest:digest)
  in
  let encoded_v2 = A.encode v2 in
  Alcotest.(check bool) "distinct bytes" true (legacy <> encoded_v2);
  Alcotest.(check bool)
    "legacy remains view-v0" true
    (A.runtime_profile (sample ())
    = A.Quickjs_emscripten_0_32_0_worker_v1_view_v0);
  check_refused "v2 expectation rejects v1" A.Wrong_runtime_profile
    (decode_for ~runtime:A.Quickjs_emscripten_0_32_0_worker_v1_view_v2 legacy);
  check_refused "v1 expectation rejects v2" A.Wrong_runtime_profile
    (decode_for encoded_v2);
  Alcotest.(check bool)
    "v2 exact round trip" true
    (Result.is_ok
       (decode_for ~runtime:A.Quickjs_emscripten_0_32_0_worker_v1_view_v2
          encoded_v2))

let test_admission_format_v2_is_strict () =
  let schema_digest = String.make 64 'b' in
  let value =
    ok
      (A.create_v3 ~target:base_target ~revision:3 ~code_digest:digest
         ~input_schema_digest:schema_digest)
  in
  let encoded = A.encode value in
  let decode ?(expected_schema_digest = schema_digest) bytes =
    A.decode_v2 ~expected_target:base_target ~expected_revision:3
      ~expected_digest:digest ~expected_schema_digest
      ~expected_compiler_profile:A.Esbuild_0_25_10_bwrap_v1
      ~expected_runtime_profile:
        A.Quickjs_emscripten_0_32_0_worker_v2_view_v2_input_v1 bytes
  in
  Alcotest.(check bool)
    "v2 exact round trip" true
    (Result.is_ok (decode encoded));
  check_refused "distinct schema mismatch" A.Wrong_schema_digest
    (decode ~expected_schema_digest:(String.make 64 'c') encoded);
  check_refused "v1 decoder unchanged" A.Invalid_fields (decode_for encoded);
  check_refused "v2 refuses v1" A.Invalid_fields (decode (A.encode (sample ())));
  check_refused "v2 extra" A.Invalid_fields
    (decode (wire (fields encoded @ [ ("snapshot", `Null) ])))

let () =
  Alcotest.run "demo runtime admission"
    [
      ( "v1",
        [
          Alcotest.test_case "shared canonical vector" `Quick test_shared_vector;
          Alcotest.test_case "closed canonical shape" `Quick
            test_closed_canonical_shape;
          Alcotest.test_case "independent expectations" `Quick
            test_independent_expectations;
          Alcotest.test_case "profiles limits and bounds" `Quick
            test_profiles_limits_and_bounds;
          Alcotest.test_case "explicit v2 profile" `Quick
            test_v2_is_explicit_and_does_not_reinterpret_v1;
          Alcotest.test_case "strict admission format v2" `Quick
            test_admission_format_v2_is_strict;
        ] );
    ]
