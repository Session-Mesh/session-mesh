(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let version = 1

type code = Bad_request | Unsupported_version | Unknown_op | Too_large | Internal | Code of string

let code_to_string = function
  | Bad_request -> "bad_request"
  | Unsupported_version -> "unsupported_version"
  | Unknown_op -> "unknown_op"
  | Too_large -> "too_large"
  | Internal -> "internal"
  | Code code -> code

let code_of_string = function
  | "bad_request" -> Bad_request
  | "unsupported_version" -> Unsupported_version
  | "unknown_op" -> Unknown_op
  | "too_large" -> Too_large
  | "internal" -> Internal
  | other -> Code other

type error = { code : code; message : string }
type fields = (string * Yojson.Safe.t) list

type request = {
  req : Yojson.Safe.t option;
  op : string;
  request_version : int;
  fields : fields;
}

let reserved = [ "v"; "req"; "op"; "ok"; "error"; "event" ]
let free fields = List.filter (fun (key, _) -> not (List.mem key reserved)) fields
let fail code message = { code; message }

let decode_version fields =
  match List.assoc_opt "v" fields with
  | None -> Ok version
  | Some (`Int requested) when requested >= 1 && requested <= version -> Ok requested
  | Some (`Int _) -> Error (fail Unsupported_version (Printf.sprintf "this peer speaks version %d" version))
  | Some _ -> Error (fail Bad_request "v must be an integer")

(* A [req] is echoed in every frame: one that has no strict JSON form (a NaN,
   which the decoder accepts as Python does) is refused at once, and answered
   without it. *)
let echoable = function
  | None -> Ok ()
  | Some req -> (
      match Mesh_jsonl_value.encode ~max_bytes:max_int req with
      | Ok _ -> Ok ()
      | Error problem ->
          Error (fail Bad_request ("req cannot be echoed: " ^ Mesh_jsonl_value.error_message problem)))

let decode_request limits line =
  match Mesh_jsonl_value.decode limits line with
  | Error problem -> Error (None, fail Bad_request (Mesh_jsonl_value.error_message problem))
  | Ok (`Assoc fields) -> (
      let req = List.assoc_opt "req" fields in
      match (echoable req, decode_version fields, List.assoc_opt "op" fields) with
      | Error problem, _, _ -> Error (None, problem)
      | Ok (), Error problem, _ -> Error (req, problem)
      | Ok (), Ok request_version, Some (`String op) when op <> "" ->
          Ok { req; op; request_version; fields }
      | Ok (), Ok _, _ -> Error (req, fail Bad_request "op must be a non-empty string"))
  | Ok _ -> Error (None, fail Bad_request "request must be a JSON object")

let head req = ("v", `Int version) :: (match req with Some value -> [ ("req", value) ] | None -> [])

let request ?req op fields : Yojson.Safe.t =
  `Assoc (head req @ (("op", `String op) :: free fields))

let ok req fields : Yojson.Safe.t = `Assoc (head req @ (("ok", `Bool true) :: free fields))

let error req problem : Yojson.Safe.t =
  let detail =
    `Assoc [ ("code", `String (code_to_string problem.code)); ("message", `String problem.message) ]
  in
  `Assoc (head req @ [ ("ok", `Bool false); ("error", detail) ])

let event req name fields : Yojson.Safe.t =
  `Assoc (head req @ (("event", `String name) :: free fields))

type frame =
  | Event of { req : Yojson.Safe.t option; name : string; fields : fields }
  | Final of { req : Yojson.Safe.t option; result : (fields, error) result }

let decode_error = function
  | `Assoc detail ->
      let text key = match List.assoc_opt key detail with Some (`String s) -> s | _ -> "" in
      Ok { code = code_of_string (text "code"); message = text "message" }
  | _ -> Error (fail Bad_request "error must be an object")

let frame_of_fields fields =
  let req = List.assoc_opt "req" fields in
  match (List.assoc_opt "ok" fields, List.assoc_opt "event" fields) with
  | Some (`Bool true), _ -> Ok (Final { req; result = Ok (free fields) })
  | Some (`Bool false), _ ->
      let detail = Option.value (List.assoc_opt "error" fields) ~default:`Null in
      Result.map (fun problem -> Final { req; result = Error problem }) (decode_error detail)
  | None, Some (`String name) -> Ok (Event { req; name; fields = free fields })
  | _ -> Error (fail Bad_request "a frame needs a boolean ok or a string event")

let decode_frame limits line =
  match Mesh_jsonl_value.decode limits line with
  | Error problem -> Error (fail Bad_request (Mesh_jsonl_value.error_message problem))
  | Ok (`Assoc fields) -> (
      match decode_version fields with
      | Error problem -> Error problem
      | Ok _ -> frame_of_fields fields)
  | Ok _ -> Error (fail Bad_request "frame must be a JSON object")
