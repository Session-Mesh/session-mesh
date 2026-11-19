(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let is_space = function
  | ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c' | '\x1c' .. '\x1f' -> true
  | _ -> false

let strip text =
  let length = String.length text in
  let rec first i =
    if i < length && is_space text.[i] then first (i + 1) else i
  in
  let rec last i = if i >= 0 && is_space text.[i] then last (i - 1) else i in
  let start = first 0 and stop = last (length - 1) in
  if stop < start then "" else String.sub text start (stop - start + 1)

let escape_byte buffer quote byte =
  match byte with
  | '\\' -> Buffer.add_string buffer "\\\\"
  | '\t' -> Buffer.add_string buffer "\\t"
  | '\n' -> Buffer.add_string buffer "\\n"
  | '\r' -> Buffer.add_string buffer "\\r"
  | c when c = quote ->
      Buffer.add_char buffer '\\';
      Buffer.add_char buffer c
  | c when Char.code c < 0x20 || Char.code c = 0x7f ->
      Buffer.add_string buffer (Printf.sprintf "\\x%02x" (Char.code c))
  | c -> Buffer.add_char buffer c

let repr value =
  let quote =
    if String.contains value '\'' && not (String.contains value '"') then '"'
    else '\''
  in
  let buffer = Buffer.create (String.length value + 2) in
  Buffer.add_char buffer quote;
  String.iter (escape_byte buffer quote) value;
  Buffer.add_char buffer quote;
  Buffer.contents buffer

(* Unicode text, by code point. *)

let is_unicode_space code =
  (code >= 0x09 && code <= 0x0d)
  || (code >= 0x1c && code <= 0x20)
  || code = 0x85 || code = 0xa0 || code = 0x1680
  || (code >= 0x2000 && code <= 0x200a)
  || code = 0x2028 || code = 0x2029 || code = 0x202f || code = 0x205f
  || code = 0x3000

(* The code points of [text]; an invalid sequence becomes U+FFFD. *)
let code_points text =
  let length = String.length text in
  let rec walk index acc =
    if index >= length then List.rev acc
    else
      let decoded = String.get_utf_8_uchar text index in
      let step = max 1 (Uchar.utf_decode_length decoded) in
      walk (index + step) (Uchar.utf_decode_uchar decoded :: acc)
  in
  walk 0 []

let of_code_points points =
  let buffer = Buffer.create 64 in
  List.iter (Buffer.add_utf_8_uchar buffer) points;
  Buffer.contents buffer

let is_space_point point = is_unicode_space (Uchar.to_int point)

let rec drop_spaces = function
  | point :: rest when is_space_point point -> drop_spaces rest
  | points -> points

let unicode_strip text =
  code_points text |> drop_spaces |> List.rev |> drop_spaces |> List.rev
  |> of_code_points

let unicode_lstrip text = code_points text |> drop_spaces |> of_code_points

(* Python's [str.split()]: the words, in order. *)
let words points =
  let flush word acc = if word = [] then acc else List.rev word :: acc in
  let rec walk word acc = function
    | [] -> List.rev (flush word acc)
    | point :: rest when is_space_point point -> walk [] (flush word acc) rest
    | point :: rest -> walk (point :: word) acc rest
  in
  walk [] [] points

let collapsed_points text =
  let space = Uchar.of_int 0x20 in
  words (code_points text)
  |> List.mapi (fun index word -> if index = 0 then word else space :: word)
  |> List.concat

let collapse_spaces text = of_code_points (collapsed_points text)

let rec take count = function
  | point :: rest when count > 0 -> point :: take (count - 1) rest
  | _ -> []

let prefix ~code_points:count text =
  of_code_points (take count (code_points text))

let clip ?(max = 240) text =
  let points = collapsed_points text in
  if List.compare_length_with points max <= 0 then of_code_points points
  else of_code_points (take (max - 1) points) ^ "\xe2\x80\xa6"
