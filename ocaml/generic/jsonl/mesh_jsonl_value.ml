(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type limits = { max_bytes : int; max_depth : int }

let default_limits = { max_bytes = 1024 * 1024; max_depth = 128 }

type error = Too_large | Too_deep | Invalid of string

let error_message = function
  | Too_large -> "line too long"
  | Too_deep -> "nested too deeply"
  | Invalid message -> "not JSON: " ^ message

(* One pass over the bytes. Inside a string, a backslash hides the next byte
   (an escaped quote does not end the string); outside, brackets and braces
   open and close levels. *)
let depth_within ~max_depth text =
  let length = String.length text in
  let rec outside index depth =
    if index >= length then true
    else
      match String.unsafe_get text index with
      | '[' | '{' -> depth < max_depth && outside (index + 1) (depth + 1)
      | ']' | '}' -> outside (index + 1) (max 0 (depth - 1))
      | '"' -> inside (index + 1) depth
      | _ -> outside (index + 1) depth
  and inside index depth =
    if index >= length then true
    else
      match String.unsafe_get text index with
      | '\\' -> inside (index + 2) depth
      | '"' -> outside (index + 1) depth
      | _ -> inside (index + 1) depth
  in
  outside 0 0

let rec keep_last_keys (json : Yojson.Safe.t) : Yojson.Safe.t =
  match json with
  | `List items -> `List (List.map keep_last_keys items)
  | `Assoc fields -> `Assoc (last_fields fields)
  | other -> other

and last_fields fields =
  let last = Hashtbl.create (List.length fields) in
  List.iter (fun (key, value) -> Hashtbl.replace last key value) fields;
  if Hashtbl.length last = List.length fields then
    List.map (fun (key, value) -> (key, keep_last_keys value)) fields
  else
    List.filter_map
      (fun (key, _) ->
        match Hashtbl.find_opt last key with
        | None -> None
        | Some value ->
            Hashtbl.remove last key;
            Some (key, keep_last_keys value))
      fields

let decode limits text =
  if String.length text > limits.max_bytes then Error Too_large
  else if not (depth_within ~max_depth:limits.max_depth text) then Error Too_deep
  else
    match Yojson.Safe.from_string text with
    | json -> Ok (keep_last_keys json)
    | exception Yojson.Json_error message -> Error (Invalid message)
    | exception (Failure message | Invalid_argument message) -> Error (Invalid message)
    | exception End_of_file -> Error (Invalid "empty")

let encode ~max_bytes json =
  let text = Yojson.Safe.to_string json in
  if String.length text > max_bytes then Error Too_large else Ok text
