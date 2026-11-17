(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type frame = { kind : char; payload : string }

type decode_error =
  | Incomplete_header
  | Incomplete_payload
  | Payload_too_large of { kind : char; declared : int64; maximum : int }

let max_small_frame = 256 * 1024
let max_data_frame = 8 * 1024 * 1024
let maximum_for_kind = function 'D' -> max_data_frame | _ -> max_small_frame

let declared_length wire =
  let byte index = Int64.of_int (Char.code wire.[index]) in
  Int64.logor
    (Int64.shift_left (byte 1) 24)
    (Int64.logor
       (Int64.shift_left (byte 2) 16)
       (Int64.logor (Int64.shift_left (byte 3) 8) (byte 4)))

let encode { kind; payload } =
  let length = String.length payload in
  let maximum = maximum_for_kind kind in
  if length > maximum then invalid_arg "mesh_wire.encode: payload too large";
  let header = Bytes.create 5 in
  Bytes.set header 0 kind;
  Bytes.set header 1 (Char.chr ((length lsr 24) land 0xff));
  Bytes.set header 2 (Char.chr ((length lsr 16) land 0xff));
  Bytes.set header 3 (Char.chr ((length lsr 8) land 0xff));
  Bytes.set header 4 (Char.chr (length land 0xff));
  Bytes.unsafe_to_string header ^ payload

let decode wire =
  if String.length wire < 5 then Error Incomplete_header
  else
    let kind = wire.[0] in
    let declared = declared_length wire in
    let maximum = maximum_for_kind kind in
    if Int64.compare declared (Int64.of_int maximum) > 0 then
      Error (Payload_too_large { kind; declared; maximum })
    else
      let length = Int64.to_int declared in
      if String.length wire - 5 < length then Error Incomplete_payload
      else
        let payload = String.sub wire 5 length in
        let remaining =
          String.sub wire (5 + length) (String.length wire - 5 - length)
        in
        Ok ({ kind; payload }, remaining)

let ascii predicate value =
  String.length value > 0
  && String.for_all
       (fun character -> Char.code character < 128 && predicate character)
       value

let is_lower_hex character =
  match character with '0' .. '9' | 'a' .. 'f' -> true | _ -> false

let is_name_character = function
  | 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '_' | '-' -> true
  | _ -> false

let valid_name name = String.length name <= 48 && ascii is_name_character name

let valid_hex ~length value =
  String.length value = length && ascii is_lower_hex value

let derived_key master_token =
  Digestif.SHA256.hmac_string ~key:master_token "session-mesh/session-token/v1"
  |> Digestif.SHA256.to_raw_string

let expected_mac ~master_token ~name ~nonce =
  Digestif.SHA256.hmac_string ~key:(derived_key master_token)
    ("ms1\000" ^ name ^ "\000" ^ nonce)

let verify_session_token ~master_token token =
  match String.split_on_char '.' token with
  | [ "ms1"; name; nonce; mac ]
    when valid_name name && valid_hex ~length:32 nonce
         && valid_hex ~length:64 mac ->
      Option.bind (Digestif.SHA256.of_hex_opt mac) (fun supplied ->
          let expected = expected_mac ~master_token ~name ~nonce in
          if Digestif.SHA256.equal supplied expected then Some (name, nonce)
          else None)
  | _ -> None
