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
