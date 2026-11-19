(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type kind = Control | Invisible

let is_control cp = (cp < 0x20 && cp <> 0x0A && cp <> 0x09) || cp = 0x7F || (cp >= 0x80 && cp <= 0x9F)

let is_invisible cp =
  cp = 0x061C || cp = 0x200B || cp = 0x200E || cp = 0x200F || cp = 0x2028 || cp = 0x2029
  || (cp >= 0x202A && cp <= 0x202E)
  || (cp >= 0x2060 && cp <= 0x2064)
  || (cp >= 0x2066 && cp <= 0x2069)
  || cp = 0xFEFF
  || (cp >= 0xFFF9 && cp <= 0xFFFB)
  || (cp >= 0xE0000 && cp <= 0xE007F)

let replacement = "\xEF\xBF\xBD"

(* Calls [f valid code_point start length] for each decoded unit; an invalid
   sequence is consumed as the decoder reports it. *)
let iter_units f s =
  let n = String.length s in
  let rec go i =
    if i < n then begin
      let d = String.get_utf_8_uchar s i in
      let len = Uchar.utf_decode_length d in
      f (Uchar.utf_decode_is_valid d) (Uchar.to_int (Uchar.utf_decode_uchar d)) i len;
      go (i + len)
    end
  in
  go 0

exception Found of kind

let first_unsafe s =
  try
    iter_units
      (fun valid cp _ _ ->
        if valid then
          if is_control cp then raise (Found Control) else if is_invisible cp then raise (Found Invisible))
      s;
    None
  with Found k -> Some k

let has_control s =
  try
    iter_units (fun valid cp _ _ -> if valid && is_control cp then raise (Found Control)) s;
    false
  with Found _ -> true

let rebuild ~keep s =
  let b = Buffer.create (String.length s) in
  iter_units
    (fun valid cp i len ->
      if not valid then Buffer.add_string b replacement else if keep cp then Buffer.add_substring b s i len)
    s;
  Buffer.contents b

let strip_controls s = if not (has_control s) then s else rebuild ~keep:(fun cp -> not (is_control cp)) s
let repair s = if String.is_valid_utf_8 s then s else rebuild ~keep:(fun _ -> true) s

let clean s =
  if String.is_valid_utf_8 s && first_unsafe s = None then s
  else rebuild ~keep:(fun cp -> not (is_control cp || is_invisible cp)) s
