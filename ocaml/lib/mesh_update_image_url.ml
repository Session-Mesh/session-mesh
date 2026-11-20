(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let url_limit = 2048
let suffix_from text index = String.sub text index (String.length text - index)

(* ---- the URL *)

type url = { text : string; host : string; rest : string }

let label_char = function 'a' .. 'z' | '0' .. '9' | '-' -> true | _ -> false

let allowed_host host =
  let suffix = ".githubusercontent.com" in
  host = "github.com"
  || String.ends_with ~suffix host
     && List.for_all
          (fun label -> label <> "" && String.for_all label_char label)
          (String.split_on_char '.'
             (String.sub host 0 (String.length host - String.length suffix)))

(* The index of the first of [chars] in [text], or its length. *)
let first_of chars text =
  let rec go index =
    if index >= String.length text || String.contains chars text.[index] then
      index
    else go (index + 1)
  in
  go 0

(* The host of an authority: no userinfo, no port but 443. *)
let authority_host authority =
  if String.contains authority '@' then None
  else
    match String.index_opt authority ':' with
    | None -> Some authority
    | Some index when suffix_from authority (index + 1) = "443" ->
        Some (String.sub authority 0 index)
    | Some _ -> None

let image_url text =
  let prefix = "https://" in
  let forbidden char = char <= ' ' || char = '\127' || char = '\\' in
  if
    String.length text > url_limit
    || (not (String.starts_with ~prefix text))
    || String.exists forbidden text
  then None
  else
    let after = suffix_from text (String.length prefix) in
    let stop = first_of "/?#" after in
    match authority_host (String.sub after 0 stop) with
    | Some host when allowed_host host ->
        let rest = suffix_from after stop in
        let rest = String.sub rest 0 (first_of "#" rest) in
        let rest =
          if String.starts_with ~prefix:"/" rest then rest else "/" ^ rest
        in
        Some { text; host; rest }
    | _ -> None

(* ---- written in the notes *)

let utf_8 code =
  if code > 0 && Uchar.is_valid code then (
    let buffer = Buffer.create 4 in
    Buffer.add_utf_8_uchar buffer (Uchar.of_int code);
    Some (Buffer.contents buffer))
  else None

let digits_value ~base text =
  let digit char =
    match char with
    | '0' .. '9' -> Some (Char.code char - 48)
    | 'a' .. 'f' when base = 16 -> Some (Char.code char - 87)
    | 'A' .. 'F' when base = 16 -> Some (Char.code char - 55)
    | _ -> None
  in
  if text = "" || String.length text > 7 then None
  else
    String.fold_left
      (fun value char ->
        match (value, digit char) with
        | Some value, Some digit -> Some ((value * base) + digit)
        | _ -> None)
      (Some 0) text

let reference name =
  let numeric = String.length name > 1 && name.[0] = '#' in
  match name with
  | "amp" -> Some "&"
  | "lt" -> Some "<"
  | "gt" -> Some ">"
  | "quot" -> Some "\""
  | "apos" -> Some "'"
  | _ when numeric && (name.[1] = 'x' || name.[1] = 'X') ->
      Option.bind (digits_value ~base:16 (suffix_from name 2)) utf_8
  | _ when numeric ->
      Option.bind (digits_value ~base:10 (suffix_from name 1)) utf_8
  | _ -> None

let html_unescape text =
  let buffer = Buffer.create (String.length text) in
  let rec go index =
    if index < String.length text then
      match (text.[index], String.index_from_opt text index ';') with
      | '&', Some stop when stop - index <= 10 -> (
          match reference (String.sub text (index + 1) (stop - index - 1)) with
          | Some decoded ->
              Buffer.add_string buffer decoded;
              go (stop + 1)
          | None ->
              Buffer.add_char buffer '&';
              go (index + 1))
      | char, _ ->
          Buffer.add_char buffer char;
          go (index + 1)
  in
  go 0;
  Buffer.contents buffer

let contains ~within text =
  let length = String.length text and limit = String.length within in
  let rec matches start offset =
    offset = length
    || (within.[start + offset] = text.[offset] && matches start (offset + 1))
  in
  let rec from start =
    start + length <= limit && (matches start 0 || from (start + 1))
  in
  length > 0 && from 0

let in_notes ~notes url =
  contains ~within:notes url || contains ~within:(html_unescape notes) url

(* ---- public addresses *)

let ipv4_public a b c =
  not
    (a = 0 || a = 10 || a = 127 || a >= 224
    || (a = 100 && b land 0xc0 = 64)
    || (a = 169 && b = 254)
    || (a = 172 && b land 0xf0 = 16)
    || (a = 192 && b = 0 && (c = 0 || c = 2))
    || (a = 192 && b = 88 && c = 99)
    || (a = 192 && b = 168)
    || (a = 198 && (b = 18 || b = 19))
    || (a = 198 && b = 51 && c = 100)
    || (a = 203 && b = 0 && c = 113))

(* The groups of one side of [::]: 16-bit values, an IPv4 tail as two. *)
let ipv6_side text =
  let group part =
    match List.map int_of_string_opt (String.split_on_char '.' part) with
    | [ Some a; Some b; Some c; Some d ] ->
        Some [ (a lsl 8) lor b; (c lsl 8) lor d ]
    | _ when String.length part <= 4 ->
        Option.map (fun value -> [ value ]) (digits_value ~base:16 part)
    | _ -> None
  in
  if text = "" then Some []
  else
    List.fold_left
      (fun found part ->
        match (found, group part) with
        | Some found, Some groups -> Some (found @ groups)
        | _ -> None)
      (Some [])
      (String.split_on_char ':' text)

(* The eight groups of a textual IPv6 address (as inet_ntop writes it). *)
let ipv6_groups text =
  let rec double index =
    if index + 1 >= String.length text then None
    else if text.[index] = ':' && text.[index + 1] = ':' then Some index
    else double (index + 1)
  in
  match double 0 with
  | None -> (
      match ipv6_side text with
      | Some groups when List.length groups = 8 -> Some groups
      | _ -> None)
  | Some index -> (
      match
        ( ipv6_side (String.sub text 0 index),
          ipv6_side (suffix_from text (index + 2)) )
      with
      | Some left, Some right when List.length left + List.length right < 8 ->
          let zeros = 8 - List.length left - List.length right in
          Some (left @ List.init zeros (fun _ -> 0) @ right)
      | _ -> None)

let ipv6_public = function
  | [ 0; 0; 0; 0; 0; 0xffff; high; low ] ->
      ipv4_public (high lsr 8) (high land 0xff) (low lsr 8)
  | first :: second :: _ ->
      first land 0xe000 = 0x2000 (* 2000::/3, global unicast *)
      && not
           ((first = 0x2001 && second land 0xfe00 = 0) (* 2001::/23 *)
           || (first = 0x2001 && second = 0x0db8) (* documentation *)
           || first = 0x2002 (* 6to4 *)
           || first land 0xfff0 = 0x3ff0 (* 3fff::/20, documentation *))
  | _ -> false

let public_address address =
  let text = Unix.string_of_inet_addr address in
  if String.contains text ':' then
    Option.fold ~none:false ~some:ipv6_public (ipv6_groups text)
  else
    match List.map int_of_string_opt (String.split_on_char '.' text) with
    | [ Some a; Some b; Some c; Some _ ] -> ipv4_public a b c
    | _ -> false

(* ---- redirects *)

(* A scheme ends at the first ':', before any '/', '?' or '#'. *)
let has_scheme location =
  let stop = first_of ":/?#" location in
  stop > 0 && stop < String.length location && location.[stop] = ':'

let join ~base location =
  if location = "" then ""
  else if has_scheme location then location
  else if String.starts_with ~prefix:"//" location then "https:" ^ location
  else
    let origin = "https://" ^ base.host in
    if String.starts_with ~prefix:"/" location then origin ^ location
    else
      let path = String.sub base.rest 0 (first_of "?" base.rest) in
      origin ^ String.sub path 0 (String.rindex path '/' + 1) ^ location
