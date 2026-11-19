(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The implicit resolvers of a YAML 1.1 loader (PyYAML's safe loader, the one
   `wl` uses), as hand-written matchers: a plain scalar is a string unless one
   of them matches the whole text. Note the quirks that are kept on purpose:
   `1e3` and `1.5e3` are strings (an exponent needs a sign), `0o17` is a
   string, `010` is an octal integer, `2fa` and `3d` are strings. *)

let is_digit c = c >= '0' && c <= '9'
let is_digit_us c = is_digit c || c = '_'
let is_octal_us c = (c >= '0' && c <= '7') || c = '_'
let is_bin_us c = c = '0' || c = '1' || c = '_'
let is_hex_us c = is_digit c || c = '_' || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
let rest s i = String.sub s i (String.length s - i)
let all pred s = s <> "" && String.for_all pred s
let first_in s lo hi = s <> "" && s.[0] >= lo && s.[0] <= hi

let body s =
  if s <> "" && (s.[0] = '+' || s.[0] = '-') then rest s 1 else s

(* One base-60 group: [0-5]?[0-9]. *)
let sexagesimal_group p =
  match String.length p with
  | 1 -> is_digit p.[0]
  | 2 -> p.[0] >= '0' && p.[0] <= '5' && is_digit p.[1]
  | _ -> false

(* [[1-9][0-9_]*(:[0-5]?[0-9])+] *)
let sexagesimal_int b =
  match String.split_on_char ':' b with
  | head :: (_ :: _ as groups) ->
      first_in head '1' '9' && String.for_all is_digit_us (rest head 1)
      && List.for_all sexagesimal_group groups
  | _ -> false

let is_int s =
  let b = body s in
  b <> ""
  && ((String.length b > 2 && String.sub b 0 2 = "0b" && all is_bin_us (rest b 2))
     || (String.length b >= 2 && b.[0] = '0' && all is_octal_us (rest b 1))
     || b = "0"
     || (first_in b '1' '9' && String.for_all is_digit_us (rest b 1))
     || (String.length b > 2 && String.sub b 0 2 = "0x" && all is_hex_us (rest b 2))
     || sexagesimal_int b)

(* An optional exponent, which needs a sign: [([eE][-+][0-9]+)?]. *)
let exponent_ok e =
  e = ""
  || (String.length e >= 3 && (e.[0] = 'e' || e.[0] = 'E') && (e.[1] = '+' || e.[1] = '-')
     && all is_digit (rest e 2))

let span pred s i =
  let n = String.length s in
  let rec go j = if j < n && pred s.[j] then go (j + 1) else j in
  go i

(* [[0-9][0-9_]*\.[0-9_]*(exp)?] *)
let decimal_float b =
  first_in b '0' '9'
  &&
  let i = span is_digit_us b 0 in
  i < String.length b && b.[i] = '.'
  &&
  let j = span is_digit_us b (i + 1) in
  exponent_ok (rest b j)

(* [\.[0-9][0-9_]*(exp)?], without a sign. *)
let dot_float s =
  String.length s >= 2 && s.[0] = '.' && is_digit s.[1]
  &&
  let j = span is_digit_us s 1 in
  exponent_ok (rest s j)

(* [[0-9][0-9_]*(:[0-5]?[0-9])+\.[0-9_]*] *)
let rec split_last = function
  | [] -> ([], "")
  | [ x ] -> ([], x)
  | x :: rest -> let middle, last = split_last rest in (x :: middle, last)

let sexagesimal_float b =
  match String.split_on_char ':' b with
  | head :: (_ :: _ as tail) -> (
      let middle, last = split_last tail in
      first_in head '0' '9'
      && String.for_all is_digit_us head
      && List.for_all sexagesimal_group middle
      &&
      match String.index_opt last '.' with
      | Some k ->
          sexagesimal_group (String.sub last 0 k) && String.for_all is_digit_us (rest last (k + 1))
      | None -> false)
  | _ -> false

let is_float s =
  let b = body s in
  decimal_float b || dot_float s || sexagesimal_float b
  || List.mem b [ ".inf"; ".Inf"; ".INF" ]
  || List.mem s [ ".nan"; ".NaN"; ".NAN" ]

(* ---- timestamps --------------------------------------------------------- *)

let is_blank_char c = c = ' ' || c = '\t'

let ( >>= ) o f = Option.bind o f

(* The end index of [min..max] digits at [i], when at least [min] follow. *)
let take_digits s i ~min ~max =
  let j = span is_digit s i in
  if j - i < min then None else Some (if j - i > max then i + max else j)

let expect s i c = if i < String.length s && s.[i] = c then Some (i + 1) else None

let timezone s i =
  let n = String.length s in
  let k = span is_blank_char s i in
  if k < n && s.[k] = 'Z' then Some (k + 1)
  else if k < n && (s.[k] = '-' || s.[k] = '+') then
    take_digits s (k + 1) ~min:1 ~max:2 >>= fun j ->
    if j < n && s.[j] = ':' then take_digits s (j + 1) ~min:2 ~max:2 else Some j
  else None

let long_timestamp s =
  take_digits s 0 ~min:4 ~max:4 >>= fun i ->
  expect s i '-' >>= fun i ->
  take_digits s i ~min:1 ~max:2 >>= fun i ->
  expect s i '-' >>= fun i ->
  take_digits s i ~min:1 ~max:2 >>= fun i ->
  let n = String.length s in
  (if i < n && (s.[i] = 'T' || s.[i] = 't') then Some (i + 1)
   else
     let k = span is_blank_char s i in
     if k > i then Some k else None)
  >>= fun i ->
  take_digits s i ~min:1 ~max:2 >>= fun i ->
  expect s i ':' >>= fun i ->
  take_digits s i ~min:2 ~max:2 >>= fun i ->
  expect s i ':' >>= fun i ->
  take_digits s i ~min:2 ~max:2 >>= fun i ->
  let i = if i < n && s.[i] = '.' then span is_digit s (i + 1) else i in
  if i = n then Some i else timezone s i >>= fun j -> if j = n then Some j else None

let is_timestamp s =
  let n = String.length s in
  (n = 10 && s.[4] = '-' && s.[7] = '-'
   && String.for_all is_digit (String.sub s 0 4)
   && String.for_all is_digit (String.sub s 5 2)
   && String.for_all is_digit (String.sub s 8 2))
  || long_timestamp s <> None

let words =
  [ "~"; "null"; "Null"; "NULL"; "yes"; "Yes"; "YES"; "no"; "No"; "NO"; "true"; "True";
    "TRUE"; "false"; "False"; "FALSE"; "on"; "On"; "ON"; "off"; "Off"; "OFF"; "<<"; "=" ]

(* Whether an unquoted scalar is read as a string, as PyYAML does. *)
let is_plain_string s =
  s <> "" && (not (List.mem s words)) && (not (is_int s)) && (not (is_float s))
  && not (is_timestamp s)

(* The older, wider test: anything that starts like a number. Used for new ids
   written to a file, so that no YAML version can read them as numbers. *)
let numeric_like s =
  let b = body s in
  b <> ""
  && (is_digit b.[0] || (b.[0] = '.' && String.length b > 1))
  && String.for_all
       (fun c ->
         is_digit c || c = '.' || c = '_' || c = 'e' || c = 'E' || c = '+' || c = '-' || c = 'x'
         || c = 'X' || c = 'o' || c = 'O' || c = 'b' || c = 'B'
         || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))
       b

let is_conservative_string s = is_plain_string s && not (numeric_like s)
