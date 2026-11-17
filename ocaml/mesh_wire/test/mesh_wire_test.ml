(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let fixture = "wire-vectors-v1.json"

let read_file path =
  let channel = open_in_bin path in
  Fun.protect
    ~finally:(fun () -> close_in_noerr channel)
    (fun () -> In_channel.input_all channel)

let hex_to_string hex =
  let byte index = int_of_string ("0x" ^ String.sub hex index 2) in
  String.init (String.length hex / 2) (fun index -> Char.chr (byte (index * 2)))

let test_vectors () =
  let json = Yojson.Safe.from_string (read_file fixture) in
  let open Yojson.Safe.Util in
  json |> member "frames" |> to_list
  |> List.iter (fun frame ->
      let kind = String.get (frame |> member "kind" |> to_string) 0 in
      let payload =
        frame |> member "payload_hex" |> to_string |> hex_to_string
      in
      let wire = frame |> member "wire_hex" |> to_string |> hex_to_string in
      Alcotest.(check string)
        "Python frame bytes" wire
        (Mesh_wire.encode { kind; payload });
      match Mesh_wire.decode wire with
      | Ok ({ kind = decoded_kind; payload = decoded_payload }, "") ->
          Alcotest.(check char) "frame kind" kind decoded_kind;
          Alcotest.(check string) "frame payload" payload decoded_payload
      | Ok _ -> Alcotest.fail "decoder unexpectedly left fixture bytes"
      | Error _ -> Alcotest.fail "decoder rejected Python fixture");
  let token = json |> member "session_token" in
  let master_token = token |> member "master_token" |> to_string in
  let valid = token |> member "valid" |> to_string in
  Alcotest.(check (option (pair string string)))
    "valid MS1 token"
    (Some ("alpha", "0123456789abcdef0123456789abcdef"))
    (Mesh_wire.verify_session_token ~master_token valid);
  [ "bad_mac"; "other_name"; "malformed_nonce"; "different_case"; "legacy_prefix" ]
  |> List.iter (fun field ->
      Alcotest.(check (option (pair string string)))
        field None
        (Mesh_wire.verify_session_token ~master_token
           (token |> member field |> to_string)));
  json |> member "length_limits" |> to_list
  |> List.iter (fun limit ->
      let accepted = limit |> member "accepted" |> to_bool in
      let header = limit |> member "header_hex" |> to_string |> hex_to_string in
      match (accepted, Mesh_wire.decode header) with
      | true, Error Mesh_wire.Incomplete_payload -> ()
      | false, Error (Mesh_wire.Payload_too_large _) -> ()
      | _ ->
          Alcotest.fail "length-limit vector did not select the Python outcome");
  json |> member "truncated_frames" |> to_list
  |> List.iter (fun truncated ->
      let wire = truncated |> member "wire_hex" |> to_string |> hex_to_string in
      match Mesh_wire.decode wire with
      | Error Mesh_wire.Incomplete_payload -> ()
      | _ -> Alcotest.fail "truncated Python frame was not rejected")

let test_limits () =
  let too_large = String.make (Mesh_wire.max_small_frame + 1) 'x' in
  Alcotest.check_raises "small encode rejects excessive payload"
    (Invalid_argument "mesh_wire.encode: payload too large") (fun () ->
      ignore (Mesh_wire.encode { kind = 'C'; payload = too_large }));
  match Mesh_wire.decode "C\000\004\000\001" with
  | Error (Mesh_wire.Payload_too_large { kind = 'C'; declared; maximum }) ->
      Alcotest.(check int64) "declared header length" 262145L declared;
      Alcotest.(check int) "small limit" Mesh_wire.max_small_frame maximum
  | _ -> Alcotest.fail "oversized C header was not rejected before payload read"

let test_round_trip () =
  let generator =
    QCheck2.Gen.(
      pair
        (oneof_list [ 'C'; 'D'; 'R'; 'X'; 'Z' ])
        (string_size (int_bound 4096)))
  in
  QCheck2.Test.check_exn
    QCheck2.Test.(
      make ~count:200 generator (fun (kind, payload) ->
          match Mesh_wire.decode (Mesh_wire.encode { kind; payload }) with
          | Ok ({ kind = decoded_kind; payload = decoded_payload }, "") ->
              Char.equal kind decoded_kind
              && String.equal payload decoded_payload
          | _ -> false))

let () =
  Alcotest.run "mesh-wire"
    [
      ( "vectors",
        [ Alcotest.test_case "matches Python reference" `Quick test_vectors ] );
      ( "bounds",
        [
          Alcotest.test_case "refuses declared excessive payload" `Quick
            test_limits;
        ] );
      ( "round-trip",
        [ Alcotest.test_case "frames survive encoding" `Quick test_round_trip ]
      );
    ]
