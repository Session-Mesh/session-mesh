(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type format = Scene_v0 | Tsx_quickjs_v0

type error =
  | Invalid_revision
  | Invalid_content
  | Invalid_fields
  | Invalid_encoding
  | Invalid_digest
  | Unsupported_version
  | Malformed
  | Too_large
  | Wrong_target
  | Wrong_revision
  | Invalid_target of Mesh_runner_target.error

type t = {
  key : Mesh_runner_target.resource_key;
  revision : int;
  format : format;
  content : string;
  digest : string;
}

let max_content_bytes = 128 * 1024
let max_encoded_bytes = 180 * 1024
let max_revision = 9_007_199_254_740_991

let ( let* ) result next =
  match result with Ok value -> next value | Error error -> Error error

let digest_content content = Digestif.SHA256.(to_hex (digest_string content))

let create ~key ~revision ~format ~content =
  if revision < 1 || revision > max_revision then Error Invalid_revision
  else if String.length content > max_content_bytes then Error Invalid_content
  else Ok { key; revision; format; content; digest = digest_content content }

let key value = value.key
let revision value = value.revision
let format value = value.format
let content value = value.content
let digest value = value.digest

let format_name = function
  | Scene_v0 -> "mesh-scene-v0"
  | Tsx_quickjs_v0 -> "tsx-quickjs-v0"

let parse_format = function
  | "mesh-scene-v0" -> Ok Scene_v0
  | "tsx-quickjs-v0" -> Ok Tsx_quickjs_v0
  | _ -> Error Invalid_fields

let encode value =
  let module T = Mesh_runner_target in
  let key = value.key in
  Yojson.Safe.to_string
    (`Assoc
       [
         ("version", `Int 1);
         ("runner_id", `String (T.Runner_id.to_string (T.runner key)));
         ("resource_id", `String (T.Resource_id.to_string (T.resource key)));
         ("incarnation", `String (T.Incarnation.to_string (T.incarnation key)));
         ("revision", `Int value.revision);
         ("format", `String (format_name value.format));
         ("digest", `String value.digest);
         ( "content_b64",
           `String
             (Base64.encode_string ~pad:false ~alphabet:Base64.uri_safe_alphabet
                value.content) );
       ])

let exact_fields fields =
  List.sort String.compare (List.map fst fields)
  = [
      "content_b64";
      "digest";
      "format";
      "incarnation";
      "resource_id";
      "revision";
      "runner_id";
      "version";
    ]

let target ~runner ~resource ~incarnation =
  let module T = Mesh_runner_target in
  let map_error result = Result.map_error (fun e -> Invalid_target e) result in
  let* runner = map_error (T.Runner_id.of_string runner) in
  let* resource = map_error (T.Resource_id.of_string resource) in
  let* incarnation = map_error (T.Incarnation.of_string incarnation) in
  Ok (T.resource_key ~runner ~resource ~incarnation)

let decode_content text =
  if String.length text > (max_content_bytes + 2) / 3 * 4 then Error Too_large
  else
    match Base64.decode ~pad:false ~alphabet:Base64.uri_safe_alphabet text with
    | Error _ -> Error Invalid_encoding
    | Ok content ->
        if
          String.length content > max_content_bytes
          || Base64.encode_string ~pad:false ~alphabet:Base64.uri_safe_alphabet
               content
             <> text
        then Error Invalid_encoding
        else Ok content

let decode ~expected_key ~expected_revision bytes =
  if String.length bytes > max_encoded_bytes then Error Too_large
  else
    let parsed =
      try Ok (Yojson.Safe.from_string bytes)
      with Yojson.Json_error _ | Stack_overflow -> Error Malformed
    in
    let* parsed = parsed in
    match parsed with
    | `Assoc fields when exact_fields fields ->
        if List.assoc "version" fields <> `Int 1 then Error Unsupported_version
        else begin
          match
            ( List.assoc "runner_id" fields,
              List.assoc "resource_id" fields,
              List.assoc "incarnation" fields,
              List.assoc "revision" fields,
              List.assoc "format" fields,
              List.assoc "digest" fields,
              List.assoc "content_b64" fields )
          with
          | ( `String runner,
              `String resource,
              `String incarnation,
              `Int revision,
              `String format,
              `String digest,
              `String encoded ) ->
              let* key = target ~runner ~resource ~incarnation in
              if not (Mesh_runner_target.equal_resource_key expected_key key)
              then Error Wrong_target
              else if revision <> expected_revision then Error Wrong_revision
              else
                let* format = parse_format format in
                let* content = decode_content encoded in
                let* value = create ~key ~revision ~format ~content in
                if value.digest = digest then Ok value else Error Invalid_digest
          | _ -> Error Invalid_fields
        end
    | _ -> Error Invalid_fields
