(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let fixture = "mod-descriptor-v1-vectors.json"

let read_file path =
  let channel = open_in_bin path in
  Fun.protect
    ~finally:(fun () -> close_in_noerr channel)
    (fun () -> In_channel.input_all channel)

let error_name = function
  | Mesh_mod_descriptor.Too_large -> "too-large"
  | Mesh_mod_descriptor.Malformed -> "malformed"
  | Mesh_mod_descriptor.Invalid_fields -> "invalid-fields"
  | Mesh_mod_descriptor.Unsupported_version -> "unsupported-version"
  | Mesh_mod_descriptor.Invalid_mod_id -> "invalid-mod-id"
  | Mesh_mod_descriptor.Invalid_code_digest -> "invalid-code-digest"
  | Mesh_mod_descriptor.Capabilities_unavailable -> "capabilities-unavailable"

let descriptor =
  let open Mesh_mod_descriptor in
  match
    create ~mod_id:"roadmap-card"
      ~code_digest:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  with
  | Ok value -> value
  | Error _ -> Alcotest.fail "test descriptor refused"

let test_vectors () =
  let json = Yojson.Safe.from_string (read_file fixture) in
  let open Yojson.Safe.Util in
  let canonical = json |> member "canonical" |> to_string in
  match Mesh_mod_descriptor.decode canonical with
  | Error _ -> Alcotest.fail "canonical descriptor refused"
  | Ok value ->
      Alcotest.(check string)
        "canonical JSON" canonical
        (Mesh_mod_descriptor.encode value);
      Alcotest.(check string)
        "mod identifier" "roadmap-card"
        (Mesh_mod_descriptor.mod_id value);
      json |> member "invalid" |> to_list
      |> List.iter (fun invalid ->
          let name = invalid |> member "name" |> to_string in
          let expected = invalid |> member "error" |> to_string in
          let bytes = invalid |> member "bytes" |> to_string in
          match Mesh_mod_descriptor.decode bytes with
          | Ok _ -> Alcotest.failf "%s unexpectedly accepted" name
          | Error error ->
              Alcotest.(check string) name expected (error_name error))

let test_revision_identity () =
  let changed_digest =
    match
      Mesh_mod_descriptor.create ~mod_id:"roadmap-card"
        ~code_digest:
          "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    with
    | Ok value -> value
    | Error _ -> Alcotest.fail "changed digest refused"
  in
  let changed_id =
    match
      Mesh_mod_descriptor.create ~mod_id:"skills-card"
        ~code_digest:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    with
    | Ok value -> value
    | Error _ -> Alcotest.fail "changed identifier refused"
  in
  Alcotest.(check bool)
    "same revision" true
    (Mesh_mod_descriptor.same_code_revision descriptor descriptor);
  Alcotest.(check bool)
    "digest change is another revision" false
    (Mesh_mod_descriptor.same_code_revision descriptor changed_digest);
  Alcotest.(check bool)
    "identifier change is another revision" false
    (Mesh_mod_descriptor.same_code_revision descriptor changed_id)

let test_bounds () =
  let too_long = String.make (Mesh_mod_descriptor.max_encoded_bytes + 1) 'x' in
  match Mesh_mod_descriptor.decode too_long with
  | Error Mesh_mod_descriptor.Too_large -> ()
  | _ -> Alcotest.fail "oversized descriptor accepted"

let () =
  Alcotest.run "mesh-mod-descriptor"
    [
      ( "vectors",
        [ Alcotest.test_case "strict v1 descriptor" `Quick test_vectors ] );
      ( "identity",
        [
          Alcotest.test_case "digest binds revision identity" `Quick
            test_revision_identity;
        ] );
      ("bounds", [ Alcotest.test_case "encoded bound" `Quick test_bounds ]);
    ]
