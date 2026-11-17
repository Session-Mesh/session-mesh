(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module A = Mesh_demo_artifact
module T = Mesh_runner_target

let ok = function
  | Ok value -> value
  | Error _ -> Alcotest.fail "unexpected refusal"

let key runner resource incarnation =
  T.resource_key
    ~runner:(ok (T.Runner_id.of_string runner))
    ~resource:(ok (T.Resource_id.of_string resource))
    ~incarnation:(ok (T.Incarnation.of_string incarnation))

let first = key "runner_a" "resource_1" (String.make 32 'a')
let other_runner = key "runner_b" "resource_1" (String.make 32 'a')
let other_incarnation = key "runner_a" "resource_1" (String.make 32 'b')

let sample () =
  ok
    (A.create ~key:first ~revision:3 ~format:A.Tsx_quickjs_v0
       ~content:"const view = '<img src=/sink>';\000\255")

let fields value =
  match Yojson.Safe.from_string (A.encode value) with
  | `Assoc fields -> fields
  | _ -> Alcotest.fail "expected object"

let replace field value fields =
  (field, value) :: List.remove_assoc field fields

let decode_for ?(expected_key = first) ?(expected_revision = 3) bytes =
  A.decode ~expected_key ~expected_revision bytes

let decode_json fields = decode_for (Yojson.Safe.to_string (`Assoc fields))

let test_round_trip () =
  let original = sample () in
  let decoded = ok (decode_for (A.encode original)) in
  Alcotest.(check string)
    "binary content" (A.content original) (A.content decoded);
  Alcotest.(check int) "revision" 3 (A.revision decoded);
  Alcotest.(check string) "digest" (A.digest original) (A.digest decoded);
  Alcotest.(check bool)
    "other runner refused" true
    (decode_for ~expected_key:other_runner (A.encode original)
    = Error A.Wrong_target);
  Alcotest.(check bool)
    "recreated session refused" true
    (decode_for ~expected_key:other_incarnation (A.encode original)
    = Error A.Wrong_target);
  Alcotest.(check bool)
    "wrong offered revision refused" true
    (decode_for ~expected_revision:2 (A.encode original)
    = Error A.Wrong_revision);
  let scene =
    ok (A.create ~key:first ~revision:1 ~format:A.Scene_v0 ~content:"{}")
  in
  Alcotest.(check bool)
    "scene format preserved" true
    (A.format (ok (decode_for ~expected_revision:1 (A.encode scene)))
    = A.Scene_v0)

let test_closed_shape () =
  let original = sample () in
  let f = fields original in
  List.iter
    (fun changed ->
      Alcotest.(check bool)
        "closed fields" true
        (decode_json changed = Error A.Invalid_fields))
    [
      ("extra", `String "yes") :: f;
      List.remove_assoc "resource_id" f;
      replace "revision" (`String "3") f;
      replace "format" (`String "html") f;
    ];
  List.iter
    (fun version ->
      Alcotest.(check bool)
        "version refused" true
        (decode_json (replace "version" version f) = Error A.Unsupported_version))
    [ `Int 0; `Int 2; `String "1" ];
  Alcotest.(check bool)
    "invalid opaque runner" true
    (decode_json (replace "runner_id" (`String "../runner") f)
    = Error (A.Invalid_target (T.Invalid_identifier T.Runner_id)));
  Alcotest.(check bool)
    "changed digest" true
    (decode_json (replace "digest" (`String (String.make 64 '0')) f)
    = Error A.Invalid_digest);
  Alcotest.(check bool)
    "changed content" true
    (decode_json (replace "content_b64" (`String "eA") f)
    = Error A.Invalid_digest)

let test_bounds_and_encoding () =
  let original = sample () in
  let f = fields original in
  List.iter
    (fun encoded ->
      Alcotest.(check bool)
        "noncanonical content" true
        (decode_json (replace "content_b64" (`String encoded) f)
        = Error A.Invalid_encoding))
    [ "Zg=="; "Zg="; "Zg+"; "Zg/"; "Z" ];
  Alcotest.(check bool)
    "zero revision" true
    (A.create ~key:first ~revision:0 ~format:A.Scene_v0 ~content:"x"
    = Error A.Invalid_revision);
  Alcotest.(check bool)
    "unsafe JavaScript revision" true
    (A.create ~key:first ~revision:9_007_199_254_740_992 ~format:A.Scene_v0
       ~content:"x"
    = Error A.Invalid_revision);
  Alcotest.(check bool)
    "content bound" true
    (A.create ~key:first ~revision:1 ~format:A.Scene_v0
       ~content:(String.make (A.max_content_bytes + 1) 'x')
    = Error A.Invalid_content);
  Alcotest.(check bool)
    "encoded bound before parsing" true
    (decode_for (String.make (A.max_encoded_bytes + 1) '{') = Error A.Too_large);
  Alcotest.(check bool) "malformed" true (decode_for "{" = Error A.Malformed);
  let largest =
    ok
      (A.create ~key:first ~revision:1 ~format:A.Scene_v0
         ~content:(String.make A.max_content_bytes 'x'))
  in
  Alcotest.(check int)
    "exact content boundary" A.max_content_bytes
    (String.length
       (A.content (ok (decode_for ~expected_revision:1 (A.encode largest)))))

let () =
  Alcotest.run "demo artifact"
    [
      ( "contract",
        [
          Alcotest.test_case "round trip and identity" `Quick test_round_trip;
          Alcotest.test_case "closed shape" `Quick test_closed_shape;
          Alcotest.test_case "bounds and encoding" `Quick
            test_bounds_and_encoding;
        ] );
    ]
