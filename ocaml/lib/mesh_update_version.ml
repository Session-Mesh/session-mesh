(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t = { major : int; minor : int; patch : int; pre : string list }

let is_digit = function '0' .. '9' -> true | _ -> false

let is_ident_char = function
  | '0' .. '9' | 'A' .. 'Z' | 'a' .. 'z' | '-' -> true
  | _ -> false

(* At most 9 digits, so the value fits an [int] on every platform. *)
let numeric text =
  text <> ""
  && String.length text <= 9
  && String.for_all is_digit text
  && (text = "0" || text.[0] <> '0')

let number text = if numeric text then int_of_string_opt text else None

let valid_pre ident =
  ident <> ""
  && String.for_all is_ident_char ident
  && ((not (String.for_all is_digit ident)) || numeric ident)

let split_pre text =
  match String.index_opt text '-' with
  | None -> (text, Some [])
  | Some index ->
      let rest = String.sub text (index + 1) (String.length text - index - 1) in
      let idents = String.split_on_char '.' rest in
      ( String.sub text 0 index,
        if List.for_all valid_pre idents then Some idents else None )

let parse text =
  let text =
    if String.length text > 0 && text.[0] = 'v' then
      String.sub text 1 (String.length text - 1)
    else text
  in
  match split_pre text with
  | _, None -> None
  | core, Some pre -> (
      match String.split_on_char '.' core with
      | [ major; minor; patch ] -> (
          match (number major, number minor, number patch) with
          | Some major, Some minor, Some patch ->
              Some { major; minor; patch; pre }
          | _ -> None)
      | _ -> None)

(* Numeric identifiers compare as numbers and before alphanumeric ones. *)
let compare_ident left right =
  match (numeric left, numeric right) with
  | true, true -> Int.compare (int_of_string left) (int_of_string right)
  | true, false -> -1
  | false, true -> 1
  | false, false -> String.compare left right

let rec compare_pre left right =
  match (left, right) with
  | [], [] -> 0
  | [], _ -> -1
  | _, [] -> 1
  | l :: ls, r :: rs ->
      let order = compare_ident l r in
      if order <> 0 then order else compare_pre ls rs

let compare left right =
  let order = Int.compare left.major right.major in
  if order <> 0 then order
  else
    let order = Int.compare left.minor right.minor in
    if order <> 0 then order
    else
      let order = Int.compare left.patch right.patch in
      if order <> 0 then order
      else
        match (left.pre, right.pre) with
        | [], [] -> 0
        | [], _ -> 1
        | _, [] -> -1
        | l, r -> compare_pre l r

let is_prerelease version = version.pre <> []

let to_string version =
  let core =
    Printf.sprintf "%d.%d.%d" version.major version.minor version.patch
  in
  match version.pre with
  | [] -> core
  | pre -> core ^ "-" ^ String.concat "." pre
