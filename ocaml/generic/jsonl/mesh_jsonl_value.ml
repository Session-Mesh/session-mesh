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
   sees a comment, which could hide a quote from this scan. The result says
   whether a string holds a [\u] escape. *)
let scan ~max_depth text =
  let length = String.length text in
  let unicode_escape = ref false in
  let rec outside index depth =
    if index >= length then Ok !unicode_escape
    else
      match String.unsafe_get text index with
      | '[' | '{' -> if depth < max_depth then outside (index + 1) (depth + 1) else Error Too_deep
      | ']' | '}' -> outside (index + 1) (Int.max 0 (depth - 1))
      | '"' -> inside (index + 1) depth
      | '/' -> Error comment
      | _ -> outside (index + 1) depth
  and inside index depth =
    if index >= length then Ok !unicode_escape
    else
      match String.unsafe_get text index with
      | '\\' ->
          if index + 1 < length && String.unsafe_get text (index + 1) = 'u' then unicode_escape := true;
          inside (index + 2) depth
      | '"' -> outside (index + 1) depth
      | '\000' .. '\031' -> Error control
      | _ -> inside (index + 1) depth
  in
  outside 0 0

let prescan ~max_depth text = Result.map ignore (scan ~max_depth text)

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

let is_hex = function '0' .. '9' | 'a' .. 'f' | 'A' .. 'F' -> true | _ -> false

(* The UTF-16 code unit of the escape [\uXXXX] at [index], if there is one. *)
let escape_at text index =
  if index + 6 <= String.length text && text.[index] = '\\' && text.[index + 1] = 'u'
     && is_hex text.[index + 2] && is_hex text.[index + 3] && is_hex text.[index + 4] && is_hex text.[index + 5]
  then Some (int_of_string ("0x" ^ String.sub text (index + 2) 4))
  else None

let is_high unit = unit >= 0xD800 && unit <= 0xDBFF
let is_low unit = unit >= 0xDC00 && unit <= 0xDFFF
let low_at text index = match escape_at text index with Some unit -> is_low unit | None -> false

(* Walk the escapes; [copied] is where the text not yet in [out] starts. A
   backslash always takes the next byte with it, so [\\u] is no escape. *)
let rec replace_from text out index copied =
  match if index >= String.length text then None else String.index_from_opt text index '\\' with
  | None -> copied
  | Some at -> (
      match escape_at text at with
      | Some unit when is_high unit && low_at text (at + 6) -> replace_from text out (at + 12) copied
      | Some unit when is_high unit || is_low unit ->
          Buffer.add_substring out text copied (at - copied);
          Buffer.add_string out "\\uFFFD";
          replace_from text out (at + 6) (at + 6)
      | _ -> replace_from text out (at + 2) copied)

let replace_lone_surrogates text =
  if not (String.contains text '\\') then text
  else
    let out = Buffer.create (String.length text) in
    let copied = replace_from text out 0 0 in
    if copied = 0 then text
    else begin
      Buffer.add_substring out text copied (String.length text - copied);
      Buffer.contents out
    end

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
        Result.bind (scan ~max_depth:limits.max_depth text) (fun unicode_escape ->
            parse (if unicode_escape then replace_lone_surrogates text else text)))

let encode ~max_bytes json =
  match Yojson.Safe.to_string json with
  | exception (Yojson.Json_error message | Failure message | Invalid_argument message) ->
      Error (Invalid message)
  | text when String.length text > max_bytes -> Error Too_large
  | text when not (String.is_valid_utf_8 text) -> Error (Invalid "a string is not UTF-8")
  | text when String.contains text '\n' -> Error (Invalid "a literal holds a newline")
  | text -> Ok text
