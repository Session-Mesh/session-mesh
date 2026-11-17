(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type field = Runner_id | Resource_id | Incarnation | Correlation_id

type error =
  | Invalid_identifier of field
  | Metadata_too_large
  | Malformed_metadata
  | Unsupported_version
  | Invalid_fields
  | Payload_too_large

let identifier field value =
  let length = String.length value in
  if
    length >= 1 && length <= 64
    && String.for_all
         (function
           | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '_' | '-' -> true
           | _ -> false)
         value
  then Ok value
  else Error (Invalid_identifier field)

let hexadecimal field value =
  if
    String.length value = 32
    && String.for_all
         (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
         value
  then Ok value
  else Error (Invalid_identifier field)

module Runner_id = struct
  type t = string

  let of_string = identifier Runner_id
  let to_string value = value
end

module Resource_id = struct
  type t = string

  let of_string = identifier Resource_id
  let to_string value = value
end

module Incarnation = struct
  type t = string

  let of_string = hexadecimal Incarnation
  let to_string value = value
end

module Correlation_id = struct
  type t = string

  let of_string = hexadecimal Correlation_id
  let to_string value = value
end

type resource_key = {
  runner : Runner_id.t;
  resource : Resource_id.t;
  incarnation : Incarnation.t;
}

let resource_key ~runner ~resource ~incarnation =
  { runner; resource; incarnation }

let equal_resource_key = ( = )
let runner value = value.runner
let resource value = value.resource
let incarnation value = value.incarnation

type target = { key : resource_key; correlation : Correlation_id.t }

let target key correlation = { key; correlation }
let key value = value.key
let correlation value = value.correlation
let equal_target = ( = )

let encode_metadata value =
  Yojson.Safe.to_string
    (`Assoc
       [
         ("version", `Int 1);
         ("runner_id", `String (Runner_id.to_string value.key.runner));
         ("resource_id", `String (Resource_id.to_string value.key.resource));
         ("incarnation", `String (Incarnation.to_string value.key.incarnation));
         ("correlation_id", `String (Correlation_id.to_string value.correlation));
       ])

let ( let* ) result next =
  match result with Ok value -> next value | Error error -> Error error

let decode_metadata bytes =
  if String.length bytes > Mesh_wire.max_small_frame then
    Error Metadata_too_large
  else
    let parsed =
      try Ok (Yojson.Safe.from_string bytes)
      with Yojson.Json_error _ | Stack_overflow -> Error Malformed_metadata
    in
    let* parsed = parsed in
    match parsed with
    | `Assoc fields
      when List.sort String.compare (List.map fst fields)
           = [
               "correlation_id";
               "incarnation";
               "resource_id";
               "runner_id";
               "version";
             ] ->
        if List.assoc "version" fields <> `Int 1 then Error Unsupported_version
        else begin
          match
            ( List.assoc "runner_id" fields,
              List.assoc "resource_id" fields,
              List.assoc "incarnation" fields,
              List.assoc "correlation_id" fields )
          with
          | ( `String runner,
              `String resource,
              `String incarnation,
              `String correlation ) ->
              let* runner = Runner_id.of_string runner in
              let* resource = Resource_id.of_string resource in
              let* incarnation = Incarnation.of_string incarnation in
              let* correlation = Correlation_id.of_string correlation in
              Ok
                (target
                   (resource_key ~runner ~resource ~incarnation)
                   correlation)
          | _ -> Error Invalid_fields
        end
    | _ -> Error Invalid_fields

type envelope = { target : target; payload : string }

let envelope target ~payload =
  if String.length payload > Mesh_wire.max_data_frame then
    Error Payload_too_large
  else Ok { target; payload }

let envelope_target value = value.target
let payload value = value.payload
