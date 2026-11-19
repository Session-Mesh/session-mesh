(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The first, list-based form of Mesh_python_text's Unicode functions: a
   straight transcription of Python's definitions by code point, kept as the
   reference the byte scans are checked against. *)

let code_points text =
  let length = String.length text in
  let rec walk index acc =
    if index >= length then List.rev acc
    else
      let decoded = String.get_utf_8_uchar text index in
      walk (index + Int.max 1 (Uchar.utf_decode_length decoded)) (Uchar.utf_decode_uchar decoded :: acc)
  in
  walk 0 []

let of_code_points points =
  let buffer = Buffer.create 64 in
  List.iter (Buffer.add_utf_8_uchar buffer) points;
  Buffer.contents buffer

let is_space point = Mesh_python_text.is_unicode_space (Uchar.to_int point)
let rec drop_spaces = function point :: rest when is_space point -> drop_spaces rest | points -> points
let strip text = code_points text |> drop_spaces |> List.rev |> drop_spaces |> List.rev |> of_code_points
let lstrip text = code_points text |> drop_spaces |> of_code_points

let words points =
  let flush word acc = if word = [] then acc else List.rev word :: acc in
  let rec walk word acc = function
    | [] -> List.rev (flush word acc)
    | point :: rest when is_space point -> walk [] (flush word acc) rest
    | point :: rest -> walk (point :: word) acc rest
  in
  walk [] [] points

let collapsed_points text =
  words (code_points text)
  |> List.mapi (fun index word -> if index = 0 then word else Uchar.of_int 0x20 :: word)
  |> List.concat

let collapse_spaces text = of_code_points (collapsed_points text)
let rec take count = function point :: rest when count > 0 -> point :: take (count - 1) rest | _ -> []
let prefix ~code_points:count text = of_code_points (take count (code_points text))

let clip ?(max = 240) text =
  let points = collapsed_points text in
  if List.compare_length_with points max <= 0 then of_code_points points
  else of_code_points (take (max - 1) points) ^ "\xe2\x80\xa6"
