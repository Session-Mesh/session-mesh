(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type compiler_profile = Esbuild_0_25_10_bwrap_v1

type runtime_profile =
  | Quickjs_emscripten_0_32_0_worker_v1_view_v0
  | Quickjs_emscripten_0_32_0_worker_v1_view_v2
  | Quickjs_emscripten_0_32_0_worker_v2_view_v2_input_v1

type limits = {
  code_bytes : int;
  frame_time_ms : int;
  output_bytes : int;
  text_bytes : int;
  nodes : int;
  depth : int;
  update_interval_ms : int;
}

type target = { key : Mesh_runner_target.resource_key; demo_id : string }

type error =
  | Invalid_demo_id
  | Invalid_revision
  | Invalid_digest
  | Invalid_fields
  | Invalid_limits
  | Unsupported_version
  | Malformed
  | Too_large
  | Wrong_target
  | Wrong_revision
  | Wrong_digest
  | Wrong_compiler_profile
  | Wrong_runtime_profile
  | Wrong_schema_digest

type t = {
  target : target;
  revision : int;
  code_digest : string;
  compiler_profile : compiler_profile;
  runtime_profile : runtime_profile;
  limits : limits;
  input_schema_digest : string option;
}

let max_encoded_bytes = 4 * 1024
let max_revision = 9_007_199_254_740_991

let limits =
  {
    code_bytes = 128 * 1024;
    frame_time_ms = 60_000;
    output_bytes = 64 * 1024;
    text_bytes = 2_000;
    nodes = 100;
    depth = 6;
    update_interval_ms = 100;
  }

let compiler_profile_name = function
  | Esbuild_0_25_10_bwrap_v1 -> "esbuild-0.25.10-bwrap-v1"

let runtime_profile_name = function
  | Quickjs_emscripten_0_32_0_worker_v1_view_v0 ->
      "quickjs-emscripten-0.32.0+worker-v1+view-v0"
  | Quickjs_emscripten_0_32_0_worker_v1_view_v2 ->
      "quickjs-emscripten-0.32.0+worker-v1+view-v2"
  | Quickjs_emscripten_0_32_0_worker_v2_view_v2_input_v1 ->
      "quickjs-emscripten-0.32.0+worker-v2+view-v2+input-v1"

let valid_demo_id value =
  let length = String.length value in
  length >= 1 && length <= 64
  && String.for_all
       (function
         | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '_' | '-' -> true | _ -> false)
       value

let valid_digest value =
  String.length value = 64
  && String.for_all
       (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
       value

let target ~key ~demo_id =
  if valid_demo_id demo_id then Ok { key; demo_id } else Error Invalid_demo_id

let key value = value.key
let demo_id value = value.demo_id
let equal_target = ( = )

let create_with_profile runtime_profile ~target ~revision ~code_digest =
  if revision < 1 || revision > max_revision then Error Invalid_revision
  else if not (valid_digest code_digest) then Error Invalid_digest
  else
    Ok
      {
        target;
        revision;
        code_digest;
        compiler_profile = Esbuild_0_25_10_bwrap_v1;
        runtime_profile;
        limits;
        input_schema_digest = None;
      }

let create = create_with_profile Quickjs_emscripten_0_32_0_worker_v1_view_v0
let create_v2 = create_with_profile Quickjs_emscripten_0_32_0_worker_v1_view_v2

let create_v3 ~target ~revision ~code_digest ~input_schema_digest =
  if not (valid_digest input_schema_digest) then Error Invalid_digest
  else
    Result.map
      (fun value ->
        { value with input_schema_digest = Some input_schema_digest })
      (create_with_profile Quickjs_emscripten_0_32_0_worker_v2_view_v2_input_v1
         ~target ~revision ~code_digest)

let input_schema_digest value = value.input_schema_digest
let record_target value = value.target
let revision value = value.revision
let code_digest value = value.code_digest
let compiler_profile value = value.compiler_profile
let runtime_profile value = value.runtime_profile
let record_limits value = value.limits

let limits_json value =
  `Assoc
    [
      ("code_bytes", `Int value.code_bytes);
      ("frame_time_ms", `Int value.frame_time_ms);
      ("output_bytes", `Int value.output_bytes);
      ("text_bytes", `Int value.text_bytes);
      ("nodes", `Int value.nodes);
      ("depth", `Int value.depth);
      ("update_interval_ms", `Int value.update_interval_ms);
    ]

let encode value =
  let module T = Mesh_runner_target in
  let key = value.target.key in
  let fields =
    [
      ("version", `Int 1);
      ("runner_id", `String (T.Runner_id.to_string (T.runner key)));
      ("resource_id", `String (T.Resource_id.to_string (T.resource key)));
      ("incarnation", `String (T.Incarnation.to_string (T.incarnation key)));
      ("demo_id", `String value.target.demo_id);
      ("revision", `Int value.revision);
      ("format", `String "tsx-quickjs-v0");
      ("code_digest", `String value.code_digest);
      ( "compiler_profile",
        `String (compiler_profile_name value.compiler_profile) );
      ("runtime_profile", `String (runtime_profile_name value.runtime_profile));
    ]
  in
  let fields =
    match value.input_schema_digest with
    | None -> fields
    | Some digest ->
        (("version", `Int 2) :: List.tl fields)
        @ [ ("input_schema_digest", `String digest) ]
  in
  Yojson.Safe.to_string
    (`Assoc (fields @ [ ("limits", limits_json value.limits) ]))

let ( let* ) result next =
  match result with Ok value -> next value | Error error -> Error error

let exact_fields expected fields =
  List.sort String.compare (List.map fst fields)
  = List.sort String.compare expected

let record_fields =
  [
    "version";
    "runner_id";
    "resource_id";
    "incarnation";
    "demo_id";
    "revision";
    "format";
    "code_digest";
    "compiler_profile";
    "runtime_profile";
    "limits";
  ]

let record_fields_v2 =
  List.concat
    [
      List.rev (List.tl (List.rev record_fields));
      [ "input_schema_digest"; "limits" ];
    ]

let limit_fields =
  [
    "code_bytes";
    "frame_time_ms";
    "output_bytes";
    "text_bytes";
    "nodes";
    "depth";
    "update_interval_ms";
  ]

let parse_limits = function
  | `Assoc fields when exact_fields limit_fields fields -> begin
      match
        ( List.assoc "code_bytes" fields,
          List.assoc "frame_time_ms" fields,
          List.assoc "output_bytes" fields,
          List.assoc "text_bytes" fields,
          List.assoc "nodes" fields,
          List.assoc "depth" fields,
          List.assoc "update_interval_ms" fields )
      with
      | ( `Int code_bytes,
          `Int frame_time_ms,
          `Int output_bytes,
          `Int text_bytes,
          `Int nodes,
          `Int depth,
          `Int update_interval_ms ) ->
          let parsed =
            {
              code_bytes;
              frame_time_ms;
              output_bytes;
              text_bytes;
              nodes;
              depth;
              update_interval_ms;
            }
          in
          if parsed = limits then Ok parsed else Error Invalid_limits
      | _ -> Error Invalid_limits
    end
  | _ -> Error Invalid_limits

let target_of_fields ~runner ~resource ~incarnation ~demo_id =
  let module T = Mesh_runner_target in
  let map result = Result.map_error (fun _ -> Invalid_fields) result in
  let* runner = map (T.Runner_id.of_string runner) in
  let* resource = map (T.Resource_id.of_string resource) in
  let* incarnation = map (T.Incarnation.of_string incarnation) in
  target ~key:(T.resource_key ~runner ~resource ~incarnation) ~demo_id

let decode ~expected_target ~expected_revision ~expected_digest
    ~expected_compiler_profile ~expected_runtime_profile bytes =
  if String.length bytes > max_encoded_bytes then Error Too_large
  else if expected_revision < 1 || expected_revision > max_revision then
    Error Invalid_revision
  else if not (valid_digest expected_digest) then Error Invalid_digest
  else
    let parsed =
      try Ok (Yojson.Safe.from_string bytes)
      with Yojson.Json_error _ | Stack_overflow -> Error Malformed
    in
    let* parsed = parsed in
    match parsed with
    | `Assoc fields when exact_fields record_fields fields -> begin
        if List.assoc "version" fields <> `Int 1 then Error Unsupported_version
        else
          match
            ( List.assoc "runner_id" fields,
              List.assoc "resource_id" fields,
              List.assoc "incarnation" fields,
              List.assoc "demo_id" fields,
              List.assoc "revision" fields,
              List.assoc "format" fields,
              List.assoc "code_digest" fields,
              List.assoc "compiler_profile" fields,
              List.assoc "runtime_profile" fields,
              List.assoc "limits" fields )
          with
          | ( `String runner,
              `String resource,
              `String incarnation,
              `String demo_id,
              `Int revision,
              `String format,
              `String code_digest,
              `String compiler_profile,
              `String runtime_profile,
              limits_json ) ->
              if format <> "tsx-quickjs-v0" then Error Invalid_fields
              else if
                compiler_profile
                <> compiler_profile_name expected_compiler_profile
              then Error Wrong_compiler_profile
              else if
                runtime_profile <> runtime_profile_name expected_runtime_profile
              then Error Wrong_runtime_profile
              else
                let* target =
                  target_of_fields ~runner ~resource ~incarnation ~demo_id
                in
                let* _ = parse_limits limits_json in
                let create_expected =
                  match expected_runtime_profile with
                  | Quickjs_emscripten_0_32_0_worker_v1_view_v0 -> create
                  | Quickjs_emscripten_0_32_0_worker_v1_view_v2 -> create_v2
                  | Quickjs_emscripten_0_32_0_worker_v2_view_v2_input_v1 ->
                      create_v2
                in
                let* value = create_expected ~target ~revision ~code_digest in
                if encode value <> bytes then Error Invalid_fields
                else if not (equal_target target expected_target) then
                  Error Wrong_target
                else if revision <> expected_revision then Error Wrong_revision
                else if code_digest <> expected_digest then Error Wrong_digest
                else Ok value
          | _ -> Error Invalid_fields
      end
    | _ -> Error Invalid_fields

let decode_v2 ~expected_target ~expected_revision ~expected_digest
    ~expected_schema_digest ~expected_compiler_profile ~expected_runtime_profile
    bytes =
  if String.length bytes > max_encoded_bytes then Error Too_large
  else if expected_revision < 1 || expected_revision > max_revision then
    Error Invalid_revision
  else if not (valid_digest expected_digest) then Error Invalid_digest
  else if not (valid_digest expected_schema_digest) then Error Invalid_digest
  else
    let parsed =
      try Ok (Yojson.Safe.from_string bytes)
      with Yojson.Json_error _ | Stack_overflow -> Error Malformed
    in
    let* parsed = parsed in
    match parsed with
    | `Assoc fields when exact_fields record_fields_v2 fields -> begin
        if List.assoc "version" fields <> `Int 2 then Error Unsupported_version
        else
          match
            ( List.assoc "runner_id" fields,
              List.assoc "resource_id" fields,
              List.assoc "incarnation" fields,
              List.assoc "demo_id" fields,
              List.assoc "revision" fields,
              List.assoc "format" fields,
              List.assoc "code_digest" fields,
              List.assoc "compiler_profile" fields,
              List.assoc "runtime_profile" fields,
              List.assoc "input_schema_digest" fields,
              List.assoc "limits" fields )
          with
          | ( `String runner,
              `String resource,
              `String incarnation,
              `String demo_id,
              `Int revision,
              `String format,
              `String code_digest,
              `String compiler_profile,
              `String runtime_profile,
              `String schema_digest,
              limits_json ) ->
              if format <> "tsx-quickjs-v0" then Error Invalid_fields
              else if
                compiler_profile
                <> compiler_profile_name expected_compiler_profile
              then Error Wrong_compiler_profile
              else if
                runtime_profile <> runtime_profile_name expected_runtime_profile
              then Error Wrong_runtime_profile
              else
                let* target =
                  target_of_fields ~runner ~resource ~incarnation ~demo_id
                in
                let* _ = parse_limits limits_json in
                let* value =
                  create_v3 ~target ~revision ~code_digest
                    ~input_schema_digest:schema_digest
                in
                if encode value <> bytes then Error Invalid_fields
                else if not (equal_target target expected_target) then
                  Error Wrong_target
                else if revision <> expected_revision then Error Wrong_revision
                else if code_digest <> expected_digest then Error Wrong_digest
                else if schema_digest <> expected_schema_digest then
                  Error Wrong_schema_digest
                else Ok value
          | _ -> Error Invalid_fields
      end
    | _ -> Error Invalid_fields
