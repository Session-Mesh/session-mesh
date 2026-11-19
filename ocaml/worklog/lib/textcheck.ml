(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let decode s =
  (* Each element: (code point, byte offset, byte length). *)
  let n = String.length s in
  let rec go i acc =
    if i >= n then Some (List.rev acc)
    else
      let d = String.get_utf_8_uchar s i in
      if Uchar.utf_decode_is_valid d then
        let len = Uchar.utf_decode_length d in
        go (i + len) ((Uchar.to_int (Uchar.utf_decode_uchar d), i, len) :: acc)
      else None
  in
  go 0 []

let code_points s =
  Option.map (List.map (fun (cp, _, _) -> cp)) (decode s)

let length s =
  match decode s with Some l -> List.length l | None -> String.length s

let is_space cp =
  (cp >= 9 && cp <= 13)
  || (cp >= 28 && cp <= 32)
  || cp = 0x85 || cp = 0xA0 || cp = 0x1680
  || (cp >= 0x2000 && cp <= 0x200A)
  || cp = 0x2028 || cp = 0x2029 || cp = 0x202F || cp = 0x205F || cp = 0x3000

let is_blank s =
  match code_points s with
  | Some cps -> List.for_all is_space cps
  | None -> String.length s = 0

let strip s =
  match decode s with
  | None -> String.trim s
  | Some items ->
      let keep = List.filter (fun (cp, _, _) -> not (is_space cp)) items in
      (match (keep, List.rev keep) with
      | (_, first, _) :: _, (_, last, last_len) :: _ ->
          String.sub s first (last + last_len - first)
      | _ -> "")

let is_control cp =
  cp <= 0x1f
  || (cp >= 0x7f && cp <= 0x9f)
  || cp = 0x2028 || cp = 0x2029
  || (cp >= 0x202a && cp <= 0x202e)
  || (cp >= 0x2066 && cp <= 0x2069)

let has_control s =
  match code_points s with
  | Some cps -> List.exists is_control cps
  | None -> true

let name_chars_ok s =
  let ok_char c =
    (c >= 'a' && c <= 'z')
    || (c >= 'A' && c <= 'Z')
    || (c >= '0' && c <= '9')
    || c = '.' || c = '_' || c = '-'
  in
  let alnum c = ok_char c && c <> '.' && c <> '_' && c <> '-' in
  s <> "" && alnum s.[0] && String.for_all ok_char s

let valid_name s = name_chars_ok s && String.length s <= 100

let title_error s =
  if is_blank s then Some "title must not be empty"
  else if has_control s then
    Some "title must not contain newlines or control characters"
  else if length s > 200 then Some "title must be at most 200 characters"
  else None

let text_error ~field ~limit s =
  if is_blank s then Some (field ^ " must not be empty")
  else if has_control s then
    Some (field ^ " must not contain newlines or control characters")
  else if length s > limit then
    Some (Printf.sprintf "%s must be at most %d characters" field limit)
  else None

let body_text_error ~what s =
  if is_blank s then Some (what ^ " must not be empty")
  else if not (String.length s = 0 || code_points s <> None) then
    Some (what ^ " is not valid UTF-8")
  else if String.contains s '\000' then Some (what ^ " must not contain NUL")
  else if length s > 8000 then Some (what ^ " must be at most 8000 characters")
  else None

(* ASCII base letter of the Latin-1 and Latin Extended-A letters that
   Unicode decomposes into a base letter plus accents. *)
let latin_base cp =
  let in_ lo hi = cp >= lo && cp <= hi in
  let table =
    [
      (0xC0, 0xC5, 'a'); (0xE0, 0xE5, 'a'); (0xC7, 0xC7, 'c'); (0xE7, 0xE7, 'c');
      (0xC8, 0xCB, 'e'); (0xE8, 0xEB, 'e'); (0xCC, 0xCF, 'i'); (0xEC, 0xEF, 'i');
      (0xD1, 0xD1, 'n'); (0xF1, 0xF1, 'n'); (0xD2, 0xD6, 'o'); (0xF2, 0xF6, 'o');
      (0xD9, 0xDC, 'u'); (0xF9, 0xFC, 'u'); (0xDD, 0xDD, 'y'); (0xFD, 0xFD, 'y');
      (0xFF, 0xFF, 'y'); (0x100, 0x105, 'a'); (0x106, 0x10D, 'c');
      (0x10E, 0x10F, 'd'); (0x112, 0x11B, 'e'); (0x11C, 0x123, 'g');
      (0x124, 0x125, 'h'); (0x128, 0x12F, 'i'); (0x134, 0x135, 'j');
      (0x136, 0x137, 'k'); (0x139, 0x13E, 'l'); (0x143, 0x148, 'n');
      (0x14C, 0x151, 'o'); (0x154, 0x159, 'r'); (0x15A, 0x161, 's');
      (0x162, 0x165, 't'); (0x168, 0x173, 'u'); (0x174, 0x175, 'w');
      (0x176, 0x178, 'y'); (0x179, 0x17E, 'z');
    ]
  in
  List.find_map (fun (lo, hi, c) -> if in_ lo hi then Some c else None) table

let slug_char cp =
  if cp >= Char.code 'a' && cp <= Char.code 'z' then Some (Char.chr cp)
  else if cp >= Char.code 'A' && cp <= Char.code 'Z' then
    Some (Char.lowercase_ascii (Char.chr cp))
  else if cp >= Char.code '0' && cp <= Char.code '9' then Some (Char.chr cp)
  else if cp < 0x80 then None
  else latin_base cp

let trim_dashes s =
  let n = String.length s in
  let i = ref 0 and j = ref n in
  while !i < n && s.[!i] = '-' do incr i done;
  while !j > !i && s.[!j - 1] = '-' do decr j done;
  String.sub s !i (!j - !i)

let slugify title =
  let buf = Buffer.create 48 in
  let pending_dash = ref false in
  let add cp =
    match slug_char cp with
    | Some c ->
        if !pending_dash && Buffer.length buf > 0 then Buffer.add_char buf '-';
        pending_dash := false;
        Buffer.add_char buf c
    | None -> if latin_base cp = None && cp >= 0x80 then () else pending_dash := true
  in
  (match code_points title with Some cps -> List.iter add cps | None -> ());
  let s = Buffer.contents buf in
  let s = if String.length s > 40 then String.sub s 0 40 else s in
  trim_dashes s

let first_line ?(limit = 80) text =
  let line =
    match String.index_opt (strip text) '\n' with
    | Some i -> String.sub (strip text) 0 i
    | None -> strip text
  in
  let line = strip line in
  if line = "" then None
  else if length line <= limit then Some line
  else
    match decode line with
    | None -> Some (String.sub line 0 (min limit (String.length line)))
    | Some items ->
        let _, off, len = List.nth items (limit - 1) in
        Some (String.sub line 0 (off + len))
