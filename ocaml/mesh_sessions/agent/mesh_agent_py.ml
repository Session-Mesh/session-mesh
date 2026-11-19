(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let truthy = function
  | `Null | `Bool false | `Int 0 | `String "" | `List [] | `Assoc [] -> false
  | `Float f -> f <> 0.
  | `Intlit text -> text <> "0" && text <> "-0"
  | _ -> true

let is_object = function `Assoc _ -> true | _ -> false

let get key = function
  | `Assoc fields -> (
      match List.filter (fun (name, _) -> name = key) fields |> List.rev with
      | (_, value) :: _ -> value
      | [] -> `Null)
  | _ -> `Null

let string = function `String text -> Some text | _ -> None

let first_truthy values =
  let rec walk = function
    | [] -> `Null
    | [ value ] -> value
    | value :: rest -> if truthy value then value else walk rest
  in
  walk values

(* Python's [repr(float)]: the shortest digits that read back as the number,
   in positional notation when the decimal exponent is from -4 to 15, else
   as [d.ddde+XX]. *)
let shortest_decimal number =
  let rec search precision =
    let text = Printf.sprintf "%.*e" precision number in
    if precision >= 16 || float_of_string text = number then (text, precision) else search (precision + 1)
  in
  let scientific, decimals = search 0 in
  let exponent = int_of_string (List.nth (String.split_on_char 'e' scientific) 1) in
  if exponent >= -4 && exponent < 16 then Printf.sprintf "%.*f" (Int.max 0 (decimals - exponent)) number
  else scientific

let float_repr number =
  if Float.is_nan number then "nan"
  else if Float.is_integer number && Float.abs number < 1e16 then
    Printf.sprintf "%.1f" number
  else if number = Float.infinity then "inf"
  else if number = Float.neg_infinity then "-inf"
  else shortest_decimal number

let rec display = function
  | `String text -> Mesh_python_text.repr text
  | value -> str value

and str = function
  | `String text -> text
  | `Null -> "None"
  | `Bool true -> "True"
  | `Bool false -> "False"
  | `Int number -> string_of_int number
  | `Intlit text -> text
  | `Float number -> float_repr number
  | `List values -> "[" ^ String.concat ", " (List.map display values) ^ "]"
  | `Assoc fields ->
      let pair (key, value) = Mesh_python_text.repr key ^ ": " ^ display value in
      "{" ^ String.concat ", " (List.map pair fields) ^ "}"
