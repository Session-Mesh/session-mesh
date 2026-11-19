(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type invalid_utf8 = Reject | Drop
type limits = { max_bytes : int; max_depth : int; invalid_utf8 : invalid_utf8 }

let default_limits = { max_bytes = 1024 * 1024; max_depth = 128; invalid_utf8 = Reject }

type error = Too_large | Too_deep | Invalid of string

let error_message = function
  | Too_large -> "line too long"
  | Too_deep -> "nested too deeply"
  | Invalid message -> "not JSON: " ^ message

let comment = Invalid "a comment or a '/' outside a string"
let control = Invalid "a raw control character inside a string"

(* One pass over the bytes. Inside a string, a backslash hides the next byte
   (an escaped quote does not end the string) and a byte below 0x20 is
   refused; outside, brackets and braces open and close levels, and '/' is
   refused: strict JSON has none there, and refusing it means the parser never
   sees a comment, which could hide a quote from this scan. *)
let prescan ~max_depth text =
  let length = String.length text in
  let rec outside index depth =
    if index >= length then Ok ()
    else
      match String.unsafe_get text index with
      | '[' | '{' -> if depth < max_depth then outside (index + 1) (depth + 1) else Error Too_deep
      | ']' | '}' -> outside (index + 1) (max 0 (depth - 1))
      | '"' -> inside (index + 1) depth
      | '/' -> Error comment
      | _ -> outside (index + 1) depth
  and inside index depth =
    if index >= length then Ok ()
    else
      match String.unsafe_get text index with
      | '\\' -> inside (index + 2) depth
      | '"' -> outside (index + 1) depth
      | '\000' .. '\031' -> Error control
      | _ -> inside (index + 1) depth
  in
  outside 0 0

(* The maximal invalid subparts are removed: the same bytes as Python's
   [bytes.decode(errors="ignore")]. *)
let drop_invalid_utf8 text =
  if String.is_valid_utf_8 text then text
  else
    let length = String.length text in
    let out = Buffer.create length in
    let rec loop index =
      if index < length then begin
        let decoded = String.get_utf_8_uchar text index in
        let size = Uchar.utf_decode_length decoded in
        if Uchar.utf_decode_is_valid decoded then Buffer.add_string out (String.sub text index size);
        loop (index + size)
      end
    in
    loop 0;
    Buffer.contents out

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

let utf8_text limits text =
  match limits.invalid_utf8 with
  | Drop -> Ok (drop_invalid_utf8 text)
  | Reject -> if String.is_valid_utf_8 text then Ok text else Error (Invalid "not UTF-8")

let parse text =
  match Yojson.Safe.from_string text with
  | json -> Ok (keep_last_keys json)
  | exception Yojson.Json_error message -> Error (Invalid message)
  | exception (Failure message | Invalid_argument message) -> Error (Invalid message)
  | exception End_of_file -> Error (Invalid "empty")

let decode limits text =
  if String.length text > limits.max_bytes then Error Too_large
  else
    Result.bind (utf8_text limits text) (fun text ->
        Result.bind (prescan ~max_depth:limits.max_depth text) (fun () -> parse text))

let encode ~max_bytes json =
  match Yojson.Safe.to_string json with
  | exception (Yojson.Json_error message | Failure message | Invalid_argument message) ->
      Error (Invalid message)
  | text when String.length text > max_bytes -> Error Too_large
  | text when not (String.is_valid_utf_8 text) -> Error (Invalid "a string is not UTF-8")
  | text when String.contains text '\n' -> Error (Invalid "a literal holds a newline")
  | text -> Ok text
