(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type error =
  | Too_large
  | Malformed
  | Invalid_fields
  | Unsupported_version
  | Invalid_mod_id
  | Invalid_code_digest
  | Capabilities_unavailable

type t = { mod_id : string; code_digest : string }

let max_encoded_bytes = 1024
let max_mod_id_bytes = 64

let ascii predicate value =
  String.length value > 0
  && String.for_all
       (fun character -> Char.code character < 128 && predicate character)
       value

let mod_id_character = function
  | 'a' .. 'z' | '0' .. '9' | '-' -> true
  | _ -> false

let lower_hex = function '0' .. '9' | 'a' .. 'f' -> true | _ -> false

let valid_mod_id value =
  String.length value <= max_mod_id_bytes
  && ascii mod_id_character value
  && match value.[0] with 'a' .. 'z' -> true | _ -> false

let valid_code_digest value = String.length value = 64 && ascii lower_hex value

let create ~mod_id ~code_digest =
  if not (valid_mod_id mod_id) then Error Invalid_mod_id
  else if not (valid_code_digest code_digest) then Error Invalid_code_digest
  else Ok { mod_id; code_digest }

let mod_id value = value.mod_id
let code_digest value = value.code_digest

let encode value =
  Yojson.Safe.to_string
    (`Assoc
       [
         ("v", `Int 1);
         ("kind", `String "mod");
         ("mod_id", `String value.mod_id);
         ("code_digest", `String value.code_digest);
         ("capabilities", `List []);
       ])

let exact_fields fields =
  List.sort String.compare (List.map fst fields)
  = [ "capabilities"; "code_digest"; "kind"; "mod_id"; "v" ]

let decode bytes =
  if String.length bytes > max_encoded_bytes then Error Too_large
  else
    let parsed =
      try Ok (Yojson.Safe.from_string bytes)
      with Yojson.Json_error _ | Stack_overflow -> Error Malformed
    in
    match parsed with
    | Error error -> Error error
    | Ok (`Assoc fields) when exact_fields fields -> begin
        match
          ( List.assoc "v" fields,
            List.assoc "kind" fields,
            List.assoc "mod_id" fields,
            List.assoc "code_digest" fields,
            List.assoc "capabilities" fields )
        with
        | `Int 1, `String "mod", `String mod_id, `String code_digest, `List []
          ->
            create ~mod_id ~code_digest
        | `Int 1, `String "mod", `String _, `String _, `List _ ->
            Error Capabilities_unavailable
        | `Int 1, _, _, _, _ -> Error Invalid_fields
        | `Int _, _, _, _, _ -> Error Unsupported_version
        | _ -> Error Invalid_fields
      end
    | Ok _ -> Error Invalid_fields

let same_code_revision left right =
  String.equal left.mod_id right.mod_id
  && String.equal left.code_digest right.code_digest
