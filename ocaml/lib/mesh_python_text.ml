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

(* Unicode text, by code point, scanned over the bytes: ASCII needs no
   decoding, and valid sequences are copied as they are. *)

let is_unicode_space code =
  (code >= 0x09 && code <= 0x0d)
  || (code >= 0x1c && code <= 0x20)
  || code = 0x85 || code = 0xa0 || code = 0x1680
  || (code >= 0x2000 && code <= 0x200a)
  || code = 0x2028 || code = 0x2029 || code = 0x202f || code = 0x205f
  || code = 0x3000

(* The code point at [index] and its length in bytes, packed in one integer
   ([code * 8 + length]) so that a scan allocates nothing. An invalid
   sequence (its maximal invalid subpart) has code -1: it reads as U+FFFD. *)
let decode text index =
  let byte = Char.code (String.unsafe_get text index) in
  if byte < 0x80 then (byte lsl 3) lor 1
  else
    let decoded = String.get_utf_8_uchar text index in
    let length = Int.max 1 (Uchar.utf_decode_length decoded) in
    if Uchar.utf_decode_is_valid decoded then (Uchar.to_int (Uchar.utf_decode_uchar decoded) lsl 3) lor length
    else (-1 lsl 3) lor length

let code_of packed = packed asr 3
let length_of packed = packed land 7
let is_space_at text index = is_unicode_space (code_of (decode text index))

(* Copy the code point at [index] (of [packed]) to [out]. *)
let add_point out text index packed =
  if code_of packed < 0 then Buffer.add_string out "\xef\xbf\xbd"
  else Buffer.add_substring out text index (length_of packed)

(* The bytes [start, stop) of [text] as valid UTF-8. *)
let slice text start stop =
  let sub = String.sub text start (stop - start) in
  if String.is_valid_utf_8 sub then sub
  else
    let out = Buffer.create (String.length sub + 8) in
    let rec copy index =
      if index < String.length sub then begin
        let packed = decode sub index in
        add_point out sub index packed;
        copy (index + length_of packed)
      end
    in
    copy 0;
    Buffer.contents out

let lstrip_index text =
  let length = String.length text in
  let rec skip index =
    if index < length && is_space_at text index then skip (index + length_of (decode text index)) else index
  in
  skip 0

(* The end of the last code point that is not a space, at or after [start]. *)
let rstrip_index text start =
  let rec scan index stop =
    if index >= String.length text then stop
    else
      let packed = decode text index in
      let next = index + length_of packed in
      scan next (if is_unicode_space (code_of packed) then stop else next)
  in
  scan start start

let is_blank text = lstrip_index text = String.length text

let unicode_strip text =
  let start = lstrip_index text in
  slice text start (rstrip_index text start)

let unicode_lstrip text =
  let start = lstrip_index text in
  slice text start (String.length text)

let prefix ~code_points:count text =
  let out = Buffer.create (Int.min (String.length text) (4 * Int.max 0 count)) in
  let rec take index taken =
    if index < String.length text && taken < count then begin
      let packed = decode text index in
      add_point out text index packed;
      take (index + length_of packed) (taken + 1)
    end
  in
  take 0 0;
  Buffer.contents out

(* [" ".join(text.split())] written to [out] until it would hold more than
   [limit] code points. [mark] is the length of [out] after [limit - 1] code
   points; [over] whether the text went past [limit]. *)
type collapsed = { out : Buffer.t; limit : int; mutable count : int; mutable mark : int; mutable over : bool }

(* Copy [run] one-byte code points of [text] at [index]; [false] when the
   limit cut them. *)
let emit_ascii collapsed text index run =
  let taken = Int.min run (collapsed.limit - collapsed.count) in
  if collapsed.count < collapsed.limit - 1 && collapsed.count + taken >= collapsed.limit - 1 then
    collapsed.mark <- Buffer.length collapsed.out + (collapsed.limit - 1 - collapsed.count);
  Buffer.add_substring collapsed.out text index taken;
  collapsed.count <- collapsed.count + taken;
  if taken < run then collapsed.over <- true;
  taken = run

let emit_point collapsed text index packed =
  if collapsed.count >= collapsed.limit then begin
    collapsed.over <- true;
    false
  end
  else begin
    add_point collapsed.out text index packed;
    collapsed.count <- collapsed.count + 1;
    if collapsed.count = collapsed.limit - 1 then collapsed.mark <- Buffer.length collapsed.out;
    true
  end

(* The end of the run of ASCII bytes that are not spaces from [index],
   looked for up to [stop]. *)
let rec word_end text index stop =
  if index < stop then
    let byte = Char.code (String.unsafe_get text index) in
    if byte < 0x80 && not (is_unicode_space byte) then word_end text (index + 1) stop else index
  else index

let rec collapse_from collapsed text index pending =
  if index < String.length text then
    let packed = decode text index in
    if is_unicode_space (code_of packed) then collapse_from collapsed text (index + length_of packed) (collapsed.count > 0)
    else if (not pending) || emit_ascii collapsed " " 0 1 then
      if code_of packed >= 0 && code_of packed < 0x80 then begin
        (* One byte past the room is enough to see that the limit cuts the run. *)
        let room = collapsed.limit - collapsed.count in
        let stop = word_end text index (if room >= String.length text - index then String.length text else index + room + 1) in
        if emit_ascii collapsed text index (stop - index) then collapse_from collapsed text stop false
      end
      else if emit_point collapsed text index packed then collapse_from collapsed text (index + length_of packed) false

let collapse ~limit text =
  let collapsed = { out = Buffer.create 64; limit; count = 0; mark = 0; over = false } in
  collapse_from collapsed text 0 false;
  collapsed

let collapse_spaces text = Buffer.contents (collapse ~limit:max_int text).out

let clip ?(max = 240) text =
  let collapsed = collapse ~limit:max text in
  if not collapsed.over then Buffer.contents collapsed.out
  else Buffer.sub collapsed.out 0 collapsed.mark ^ "\xe2\x80\xa6"
