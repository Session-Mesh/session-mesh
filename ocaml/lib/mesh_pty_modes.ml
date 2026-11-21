(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The on/off modes, as bits of [flags]. *)
let alternate = 1
let cursor_keys = 2
let autowrap = 4
let cursor_visible = 8
let focus = 16
let bracketed_paste = 64
let keypad = 128
let default_flags = autowrap lor cursor_visible

(* What xterm.js's soft reset (DECSTR) restores: its DEC private modes, the
   cursor; not the screen or the mouse. *)
let soft_reset =
  cursor_keys lor autowrap lor cursor_visible lor focus lor bracketed_paste
  lor keypad

(* The modes restored by a prefix after the alternate screen, in order.
   Alternate scroll (1007) is not among them: xterm.js 5.5 does not
   implement it. *)
let restored =
  [
    (cursor_keys, 1);
    (autowrap, 7);
    (cursor_visible, 25);
    (focus, 1004);
    (bracketed_paste, 2004);
  ]

let flag_of_mode = function
  | 47 | 1047 | 1049 -> alternate
  | 1 -> cursor_keys
  | 7 -> autowrap
  | 25 -> cursor_visible
  | 66 -> keypad
  | 1004 -> focus
  | 2004 -> bracketed_paste
  | _ -> 0

let is_tracking = function 9 | 1000 | 1002 | 1003 -> true | _ -> false

(* The encodings xterm.js implements; it ignores 1005 and 1015, and the
   reset of either of these restores the default. *)
let is_encoding = function 1006 | 1016 -> true | _ -> false

(* A parameter past this value names no mode: digits stop counting there. *)
let too_large = 100_000

(* The parameters a sequence keeps, as in xterm.js: later ones name no mode. *)
let max_parameters = 32

(* Parser states, those of xterm.js's VT500 parser. DCS ignore and DCS
   passthrough are one state here: both end only on ESC, CAN, SUB or a C1
   control. *)
let ground = 0
let escape = 1
let escape_intermediate = 2
let csi_entry = 3
let csi_parameter = 4
let csi_intermediate = 5
let csi_ignore = 6
let sos_pm_apc = 7
let osc = 8
let dcs_entry = 9
let dcs_parameter = 10
let dcs_intermediate = 11
let dcs_string = 12

(* The class xterm.js gives every character from U+00A0. *)
let non_ascii = 0xa0

type t = {
  mutable flags : int;
  mutable tracking : int;  (** The mouse tracking mode, 0 when off. *)
  mutable encoding : int;  (** The mouse encoding mode, 0 for the default. *)
  mutable phase : int;
  (* The UTF-8 character under way, decoded as xterm.js decodes it. *)
  mutable pending : int;  (** Continuation bytes still expected. *)
  mutable codepoint : int;
  mutable minimum : int;  (** The smallest code point of that length. *)
  (* The control sequence under way. *)
  mutable leader : int;  (** The private leader byte ([?], [>]...), or 0. *)
  mutable intermediate : int;  (** 0, the one intermediate byte, or -1. *)
  mutable parameter : int;  (** -1 while empty. *)
  mutable parameters : int;  (** Parameters ended, at most [max_parameters]. *)
  mutable subparameter : bool;  (** After a [:]: digits are ignored. *)
  mutable flags_named : int;
  mutable tracking_named : int;  (** The last tracking mode named, or 0. *)
  mutable encoding_named : int;  (** The last encoding named, or 0. *)
}

let create () =
  {
    flags = default_flags;
    tracking = 0;
    encoding = 0;
    phase = ground;
    pending = 0;
    codepoint = 0;
    minimum = 0;
    leader = 0;
    intermediate = 0;
    parameter = -1;
    parameters = 0;
    subparameter = false;
    flags_named = 0;
    tracking_named = 0;
    encoding_named = 0;
  }

let copy t = { t with flags = t.flags }
let equal (a : t) b = a = b

(* xterm.js 5.5 leaves the cursor as it was on RIS. *)
let full_reset t =
  let cursor = t.flags land cursor_visible in
  t.flags <- default_flags land lnot cursor_visible lor cursor;
  t.tracking <- 0;
  t.encoding <- 0

let start_sequence t =
  t.phase <- csi_entry;
  t.leader <- 0;
  t.intermediate <- 0;
  t.parameter <- -1;
  t.parameters <- 0;
  t.subparameter <- false;
  t.flags_named <- 0;
  t.tracking_named <- 0;
  t.encoding_named <- 0

let[@inline] end_parameter t =
  let n = t.parameter in
  let kept = t.parameters < max_parameters in
  t.parameter <- -1;
  t.subparameter <- false;
  if kept then t.parameters <- t.parameters + 1;
  if kept && t.leader = 63 (* '?' *) && n >= 0 then (
    t.flags_named <- t.flags_named lor flag_of_mode n;
    if is_tracking n then t.tracking_named <- n;
    if is_encoding n then t.encoding_named <- n)

let set_modes t =
  t.flags <- t.flags lor t.flags_named;
  if t.tracking_named <> 0 then t.tracking <- t.tracking_named;
  if t.encoding_named <> 0 then t.encoding <- t.encoding_named

let reset_modes t =
  t.flags <- t.flags land lnot t.flags_named;
  if t.tracking_named <> 0 then t.tracking <- 0;
  if t.encoding_named <> 0 then t.encoding <- 0

let dispatch t final =
  end_parameter t;
  t.phase <- ground;
  match (t.leader, t.intermediate, final) with
  | 63, 0, 0x68 (* ? h *) -> set_modes t
  | 63, 0, 0x6c (* ? l *) -> reset_modes t
  | 0, 33, 0x70 (* ! p *) ->
      t.flags <- t.flags land lnot soft_reset lor (default_flags land soft_reset)
  | _ -> ()

(* What every state does with ESC, CAN, SUB and the C1 controls. *)
let[@inline] anywhere t c =
  if c = 0x1b then (
    t.phase <- escape;
    true)
  else if c = 0x18 || c = 0x1a then (
    t.phase <- ground;
    true)
  else if c < 0x80 || c >= non_ascii then false
  else (
    (match c with
    | 0x9b -> start_sequence t
    | 0x9d -> t.phase <- osc
    | 0x90 -> t.phase <- dcs_entry
    | 0x98 | 0x9e | 0x9f -> t.phase <- sos_pm_apc
    | _ -> t.phase <- ground);
    true)

let escape_code t c =
  if c >= non_ascii then t.phase <- ground
  else if c >= 0x20 && c <= 0x2f then t.phase <- escape_intermediate
  else if c >= 0x30 && c <= 0x7e then (
    t.phase <- ground;
    match Char.unsafe_chr c with
    | '[' -> start_sequence t
    | ']' -> t.phase <- osc
    | 'P' -> t.phase <- dcs_entry
    | 'X' | '^' | '_' -> t.phase <- sos_pm_apc
    | 'c' -> full_reset t
    | '=' -> t.flags <- t.flags lor keypad
    | '>' -> t.flags <- t.flags land lnot keypad
    | _ -> ())

let[@inline] parameter_byte t c =
  if c <= 0x39 then (
    if not t.subparameter then
      let digit = c - 48 in
      t.parameter <-
        (if t.parameter < 0 then digit
         else if t.parameter >= too_large then too_large
         else (t.parameter * 10) + digit))
  else if c = 0x3b then end_parameter t
  else t.subparameter <- true

(* CSI entry, parameters and intermediates: parameter bytes first, the
   commonest. *)
let[@inline] csi_code t c =
  let phase = t.phase in
  if c >= 0x30 && c <= 0x3b && phase <> csi_intermediate then (
    parameter_byte t c;
    t.phase <- csi_parameter)
  else if c >= 0x40 && c <= 0x7e then dispatch t c
  else if c >= non_ascii then t.phase <- ground
  else if c >= 0x20 && c <= 0x2f then (
    t.intermediate <- (if t.intermediate = 0 then c else -1);
    t.phase <- csi_intermediate)
  else if c >= 0x30 && c <= 0x3f then
    if phase = csi_entry && c >= 0x3c then (
      t.leader <- c;
      t.phase <- csi_parameter)
    else t.phase <- csi_ignore

(* DCS entry, parameters and intermediates, up to the payload. *)
let dcs_code t c =
  let phase = t.phase in
  if c >= non_ascii then t.phase <- ground
  else if c >= 0x40 && c <= 0x7e then t.phase <- dcs_string
  else if c >= 0x20 && c <= 0x2f then t.phase <- dcs_intermediate
  else if c >= 0x30 && c <= 0x3f then
    if phase = dcs_intermediate || (phase = dcs_parameter && c >= 0x3c) then
      t.phase <- dcs_string
    else t.phase <- dcs_parameter

(* A decoded character in the current state. C0 controls and DEL leave every
   sequence state as it is, as in xterm.js. *)
let[@inline] code_in_state t c =
  (* The states by number, for a jump table. *)
  match t.phase with
  | 1 (* escape *) -> escape_code t c
  | 2 (* escape_intermediate *) ->
      if c >= non_ascii || (c >= 0x30 && c <= 0x7e) then t.phase <- ground
  | 3 | 4 | 5 (* csi_entry, csi_parameter, csi_intermediate *) -> csi_code t c
  | 6 (* csi_ignore *) -> if c >= 0x40 && c <= 0x7e then t.phase <- ground
  | 7 (* sos_pm_apc *) -> if c >= non_ascii then t.phase <- ground
  | 8 (* osc *) -> if c = 0x07 then t.phase <- ground
  | 9 | 10 | 11 (* dcs_entry, dcs_parameter, dcs_intermediate *) -> dcs_code t c
  | _ (* ground, dcs_string *) -> ()

let[@inline] code t c =
  if (c >= 0x20 && c < 0x80) || not (anywhere t c) then code_in_state t c

let[@inline] valid_codepoint t cp =
  cp >= t.minimum
  && (cp < 0xd800 || cp > 0xdfff)
  && cp <> 0xfeff && cp <= 0x10ffff

(* One byte through xterm.js's UTF-8 decoder: an invalid byte is dropped, a
   character cut short is dropped and the byte that cut it decoded afresh, an
   overlong form, a surrogate or the byte order mark is dropped. *)
let multibyte t byte =
  if t.pending > 0 && byte land 0xc0 = 0x80 then (
    let cp = (t.codepoint lsl 6) lor (byte land 0x3f) in
    t.codepoint <- cp;
    t.pending <- t.pending - 1;
    if t.pending = 0 && valid_codepoint t cp then code t cp)
  else (
    t.pending <- 0;
    if byte land 0xe0 = 0xc0 then (
      t.pending <- 1;
      t.codepoint <- byte land 0x1f;
      t.minimum <- 0x80)
    else if byte land 0xf0 = 0xe0 then (
      t.pending <- 2;
      t.codepoint <- byte land 0x0f;
      t.minimum <- 0x800)
    else if byte land 0xf8 = 0xf0 then (
      t.pending <- 3;
      t.codepoint <- byte land 0x07;
      t.minimum <- 0x10000))

let[@inline] step t byte =
  if byte < 0x80 then (
    t.pending <- 0;
    code t byte)
  else multibyte t byte

external unsafe_get_word : Bytes.t -> int -> int64 = "%caml_bytes_get64u"

(* Whether one of the eight bytes of [word] is ESC (the zero-byte test of
   [word] xor eight ESC bytes). *)
let[@inline] has_escape word =
  let x = Int64.logxor word 0x1b1b1b1b1b1b1b1bL in
  Int64.logand
    (Int64.logand (Int64.sub x 0x0101010101010101L) (Int64.lognot x))
    0x8080808080808080L
  <> 0L

(* The first ESC from [i] before [stop], or [stop]: eight bytes at a time,
   then one. Outside a sequence only ESC is looked for: an eight-bit C1
   control there (C2 9B for CSI) is not followed, which would cost every
   word with a byte from 0x80 a second test. *)
let next_escape bytes i stop =
  let j = ref i in
  while !j + 8 <= stop && not (has_escape (unsafe_get_word bytes !j)) do
    j := !j + 8
  done;
  while !j < stop && Bytes.unsafe_get bytes !j <> '\027' do
    incr j
  done;
  !j

let feed t bytes offset length =
  if offset < 0 || length < 0 || offset > Bytes.length bytes - length then
    invalid_arg "Mesh_pty_modes.feed";
  let stop = offset + length in
  let i = ref offset in
  while !i < stop do
    if t.phase = ground then (
      let j = next_escape bytes !i stop in
      i := j + 1;
      if j < stop then (
        t.pending <- 0;
        if !i < stop && Bytes.unsafe_get bytes !i = '[' then (
          (* The commonest sequence, CSI, entered at once. *)
          start_sequence t;
          incr i)
        else t.phase <- escape))
    else
      let c = Char.code (Bytes.unsafe_get bytes !i) in
      incr i;
      (* Parameter bytes, the commonest inside a sequence, at once. *)
      if c >= 0x30 && c <= 0x3b && t.phase = csi_parameter then (
        t.pending <- 0;
        parameter_byte t c)
      else step t c
  done

let feed_string t text =
  feed t (Bytes.unsafe_of_string text) 0 (String.length text)

(* The second byte of a C1 control that starts a sequence: DCS, SOS, CSI,
   OSC, PM, APC. *)
let is_introducer = function
  | '\144' | '\152' | '\155' | '\157' | '\158' | '\159' -> true
  | _ -> false

(* Whether the bytes at [i] start a sequence that the caller sends: ESC, or
   C2 and an introducer. *)
let starts_sequence bytes i stop =
  let c = Bytes.unsafe_get bytes i in
  c = '\027'
  || c = '\194'
     && i + 1 < stop
     && is_introducer (Bytes.unsafe_get bytes (i + 1))

let finish_sequence t bytes offset length =
  if offset < 0 || length < 0 || offset > Bytes.length bytes - length then
    invalid_arg "Mesh_pty_modes.finish_sequence";
  let stop = offset + length in
  let i = ref offset in
  while !i < stop && t.phase <> ground do
    (* A new sequence cancels or ends the one under way and is sent. *)
    if starts_sequence bytes !i stop then (
      t.phase <- ground;
      t.pending <- 0)
    else (
      step t (Char.code (Bytes.unsafe_get bytes !i));
      incr i)
  done;
  if t.phase = ground then Some (!i - offset) else None

let prefix t =
  let buffer = Buffer.create 64 in
  let mode n on =
    Buffer.add_string buffer
      (Printf.sprintf "\027[?%d%c" n (if on then 'h' else 'l'))
  in
  if t.flags land alternate <> 0 then mode 1049 true;
  List.iter
    (fun (flag, n) ->
      let on = t.flags land flag <> 0 in
      if on <> (default_flags land flag <> 0) then mode n on)
    restored;
  if t.flags land keypad <> 0 then Buffer.add_string buffer "\027=";
  if t.tracking <> 0 then mode t.tracking true;
  if t.encoding <> 0 then mode t.encoding true;
  Buffer.contents buffer
