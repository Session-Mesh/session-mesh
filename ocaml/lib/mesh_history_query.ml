(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let max_terms = 16
let max_term_bytes = 128

let is_ascii_word c =
  match c with '0' .. '9' | 'a' .. 'z' | 'A' .. 'Z' -> true | _ -> false

(* Non-ASCII characters count as letters except the Unicode punctuation and
   space blocks, which separate terms. *)
let is_word_uchar u =
  let c = Uchar.to_int u in
  c >= 0xC0 && not (c >= 0x2000 && c <= 0x206F) && c <> 0x3000

let split s =
  let terms = ref [] and buf = Buffer.create 32 in
  let flush () =
    if Buffer.length buf > 0 then terms := Buffer.contents buf :: !terms;
    Buffer.clear buf
  in
  let n = String.length s in
  let rec go i =
    if i >= n then flush ()
    else if Char.code s.[i] < 0x80 then begin
      if is_ascii_word s.[i] then Buffer.add_char buf s.[i] else flush ();
      go (i + 1)
    end
    else begin
      let d = String.get_utf_8_uchar s i in
      let len = Uchar.utf_decode_length d in
      if Uchar.utf_decode_is_valid d && is_word_uchar (Uchar.utf_decode_uchar d)
      then Buffer.add_string buf (String.sub s i len)
      else flush ();
      go (i + len)
    end
  in
  go 0;
  List.rev !terms

let truncate term =
  if String.length term <= max_term_bytes then term
  else begin
    let cut = ref max_term_bytes in
    while !cut > 0 && Char.code term.[!cut] land 0xC0 = 0x80 do decr cut done;
    String.sub term 0 !cut
  end

let rec take n = function
  | x :: rest when n > 0 -> x :: take (n - 1) rest
  | _ -> []

let match_expression q =
  match take max_terms (List.map truncate (split q)) with
  | [] -> None
  | terms ->
      let last = List.length terms - 1 in
      let quote i t = if i = last then "\"" ^ t ^ "\"*" else "\"" ^ t ^ "\"" in
      Some (String.concat " " (List.mapi quote terms))
