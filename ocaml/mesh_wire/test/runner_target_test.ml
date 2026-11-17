(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module T = Mesh_runner_target

let ok = function
  | Ok value -> value
  | Error _ -> Alcotest.fail "unexpected refusal"

let test_identifiers () =
  List.iter
    (fun value ->
      Alcotest.(check string)
        "runner bytes" value
        (T.Runner_id.to_string (ok (T.Runner_id.of_string value)));
      Alcotest.(check string)
        "resource bytes" value
        (T.Resource_id.to_string (ok (T.Resource_id.of_string value))))
    [ "a"; "A0_-"; String.make 64 'z' ];
  List.iter
    (fun value ->
      Alcotest.(check bool)
        "invalid runner" true
        (T.Runner_id.of_string value = Error (T.Invalid_identifier T.Runner_id));
      Alcotest.(check bool)
        "invalid resource" true
        (T.Resource_id.of_string value
        = Error (T.Invalid_identifier T.Resource_id)))
    [ ""; String.make 65 'a'; "a/b"; "a:b"; "a.b"; " a"; "a\n"; "a\000"; "é" ];
  List.iter
    (fun value ->
      Alcotest.(check string)
        "incarnation bytes" value
        (T.Incarnation.to_string (ok (T.Incarnation.of_string value)));
      Alcotest.(check string)
        "correlation bytes" value
        (T.Correlation_id.to_string (ok (T.Correlation_id.of_string value))))
    [ String.make 32 '0'; "0123456789abcdef0123456789abcdef" ];
  List.iter
    (fun value ->
      Alcotest.(check bool)
        "invalid incarnation" true
        (T.Incarnation.of_string value
        = Error (T.Invalid_identifier T.Incarnation));
      Alcotest.(check bool)
        "invalid correlation" true
        (T.Correlation_id.of_string value
        = Error (T.Invalid_identifier T.Correlation_id)))
    [
      "";
      String.make 31 '0';
      String.make 33 '0';
      String.make 32 'A';
      String.make 32 'g';
      String.make 32 '\000';
    ]

let make_target runner resource incarnation correlation =
  T.target
    (T.resource_key
       ~runner:(ok (T.Runner_id.of_string runner))
       ~resource:(ok (T.Resource_id.of_string resource))
       ~incarnation:(ok (T.Incarnation.of_string incarnation)))
    (ok (T.Correlation_id.of_string correlation))

let sample =
  make_target "runner_a" "resource_1" (String.make 32 '0') (String.make 32 '1')

let test_metadata () =
  let encoded = T.encode_metadata sample in
  Alcotest.(check bool)
    "round-trip" true
    (T.equal_target sample (ok (T.decode_metadata encoded)));
  let fields =
    match Yojson.Safe.from_string encoded with
    | `Assoc fields -> fields
    | _ -> assert false
  in
  List.iter
    (fun json ->
      Alcotest.(check bool)
        "invalid fields" true
        (T.decode_metadata (Yojson.Safe.to_string json) = Error T.Invalid_fields))
    [
      `Assoc (("extra", `String "route") :: fields);
      `Assoc (("runner_id", `String "runner_b") :: fields);
      `Assoc (List.remove_assoc "correlation_id" fields);
      `Assoc (("resource_id", `Int 4) :: List.remove_assoc "resource_id" fields);
      `List [];
    ];
  List.iter
    (fun version ->
      Alcotest.(check bool)
        "unknown version" true
        (T.decode_metadata
           (Yojson.Safe.to_string
              (`Assoc
                 (("version", version) :: List.remove_assoc "version" fields)))
        = Error T.Unsupported_version))
    [ `Int 0; `Int 2; `String "1"; `Float 1.; `Bool true; `Null ];
  List.iter
    (fun malformed ->
      Alcotest.(check bool)
        "malformed document" true
        (T.decode_metadata malformed = Error T.Malformed_metadata))
    [
      "";
      "{";
      encoded ^ "{}";
      encoded ^ "trailing";
      String.make Mesh_wire.max_small_frame '[';
    ];
  Alcotest.(check bool)
    "size checked before malformed parsing" true
    (T.decode_metadata (String.make (Mesh_wire.max_small_frame + 1) '{')
    = Error T.Metadata_too_large);
  Alcotest.(check bool)
    "invalid identifier" true
    (T.decode_metadata
       (Yojson.Safe.to_string
          (`Assoc
             (("runner_id", `String "bad/runner")
             :: List.remove_assoc "runner_id" fields)))
    = Error (T.Invalid_identifier T.Runner_id));
  let padded =
    encoded
    ^ String.make (Mesh_wire.max_small_frame - String.length encoded) ' '
  in
  Alcotest.(check bool)
    "exact metadata boundary" true
    (T.equal_target sample (ok (T.decode_metadata padded)))

let test_payload () =
  List.iter
    (fun bytes ->
      let envelope = ok (T.envelope sample ~payload:bytes) in
      Alcotest.(check string)
        "opaque bytes unchanged" bytes (T.payload envelope);
      Alcotest.(check bool)
        "target unchanged" true
        (T.equal_target sample (T.envelope_target envelope)))
    [
      "";
      "\000\255\254\027[31mprivate-payload";
      String.make Mesh_wire.max_data_frame 'x';
    ];
  Alcotest.(check bool)
    "oversize opaque bytes" true
    (T.envelope sample ~payload:(String.make (Mesh_wire.max_data_frame + 1) 'x')
    = Error T.Payload_too_large);
  let envelope = ok (T.envelope sample ~payload:"private-payload") in
  Alcotest.(check string)
    "metadata independent of opaque bytes" (T.encode_metadata sample)
    (T.encode_metadata (T.envelope_target envelope))

let test_target_properties () =
  let property =
    QCheck.Test.make ~count:500 ~name:"all target components preserved"
      QCheck.(
        pair
          (make
             (Gen.string_size (Gen.int_range 1 64)
                ~gen:(Gen.oneof_list [ 'a'; 'Z'; '0'; '_'; '-' ])))
          (make
             (Gen.string_size (Gen.int_range 1 64)
                ~gen:(Gen.oneof_list [ 'b'; 'Y'; '1'; '_'; '-' ]))))
      (fun (runner, resource) ->
        let target =
          make_target runner resource (String.make 32 'a') (String.make 32 'b')
        in
        match T.decode_metadata (T.encode_metadata target) with
        | Error _ -> false
        | Ok decoded ->
            T.equal_target decoded target
            && T.equal_resource_key (T.key decoded) (T.key target))
  in
  QCheck.Test.check_exn ~rand:(Random.State.make [| 0x5447 |]) property;
  QCheck.Test.check_exn
    ~rand:(Random.State.make [| 0x5448 |])
    (QCheck.Test.make ~count:500 ~name:"arbitrary metadata never raises"
       QCheck.string (fun bytes ->
         match T.decode_metadata bytes with Ok _ | Error _ -> true));
  List.iter
    (fun changed ->
      Alcotest.(check bool)
        "substitution changes target" false
        (T.equal_target sample changed))
    [
      make_target "runner_b" "resource_1" (String.make 32 '0')
        (String.make 32 '1');
      make_target "runner_a" "resource_2" (String.make 32 '0')
        (String.make 32 '1');
      make_target "runner_a" "resource_1" (String.make 32 '2')
        (String.make 32 '1');
      make_target "runner_a" "resource_1" (String.make 32 '0')
        (String.make 32 '2');
    ]

let () =
  Alcotest.run "runner-target"
    [
      ( "identifier",
        [ Alcotest.test_case "bounded distinct fields" `Quick test_identifiers ]
      );
      ( "metadata",
        [ Alcotest.test_case "strict bounded v1 document" `Quick test_metadata ]
      );
      ( "opaque",
        [
          Alcotest.test_case "payload bounds and separation" `Quick test_payload;
        ] );
      ( "properties",
        [
          Alcotest.test_case "round-trip and exact equality" `Quick
            test_target_properties;
        ] );
    ]
