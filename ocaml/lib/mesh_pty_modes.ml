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
let alternate_scroll = 32
let bracketed_paste = 64
let keypad = 128
let default_flags = autowrap lor cursor_visible

(* What xterm.js's soft reset (DECSTR) restores: its DEC private modes, the
   cursor; not the screen, the mouse or alternate scroll. *)
let soft_reset =
  cursor_keys lor autowrap lor cursor_visible lor focus lor bracketed_paste
  lor keypad

(* The modes restored by a prefix after the alternate screen, in order. *)
let restored =
  [
    (cursor_keys, 1);
    (autowrap, 7);
    (cursor_visible, 25);
    (focus, 1004);
    (alternate_scroll, 1007);
    (bracketed_paste, 2004);
  ]

let flag_of_mode = function
  | 47 | 1047 | 1049 -> alternate
  | 1 -> cursor_keys
  | 7 -> autowrap
  | 25 -> cursor_visible
  | 66 -> keypad
  | 1004 -> focus
  | 1007 -> alternate_scroll
  | 2004 -> bracketed_paste
  | _ -> 0

let is_tracking = function 9 | 1000 | 1002 | 1003 -> true | _ -> false

(* Encodings as bits of [encodings_named]. *)
let encoding_bit = function
  | 1005 -> 1
  | 1006 -> 2
  | 1015 -> 4
  | 1016 -> 8
  | _ -> 0

(* A parameter past this value names no mode: digits stop counting there. *)
let too_large = 100_000

(* Parser phases. *)
let ground = 0
let escape = 1
let escape_intermediate = 2
let control_sequence = 3
let ignored_sequence = 4

type t = {
  mutable flags : int;
  mutable tracking : int;  (** The mouse tracking mode, 0 when off. *)
  mutable encoding : int;  (** The mouse encoding mode, 0 for the default. *)
  mutable phase : int;
  (* The control sequence under way. *)
  mutable started : bool;  (** A byte after [CSI] was seen. *)
  mutable private_marker : bool;
  mutable intermediate : int;  (** 0, the one intermediate byte, or -1. *)
  mutable parameter : int;  (** -1 while empty. *)
  mutable flags_named : int;
  mutable tracking_named : int;  (** The last tracking mode named, or 0. *)
  mutable encodings_named : int;
  mutable encoding_named : int;  (** The last encoding named, or 0. *)
}

let create () =
  {
    flags = default_flags;
    tracking = 0;
    encoding = 0;
    phase = ground;
    started = false;
    private_marker = false;
    intermediate = 0;
    parameter = -1;
    flags_named = 0;
    tracking_named = 0;
    encodings_named = 0;
    encoding_named = 0;
  }

let equal (a : t) b = a = b

let full_reset t =
  t.flags <- default_flags;
  t.tracking <- 0;
  t.encoding <- 0

let start_sequence t =
  t.phase <- control_sequence;
  t.started <- false;
  t.private_marker <- false;
  t.intermediate <- 0;
  t.parameter <- -1;
  t.flags_named <- 0;
  t.tracking_named <- 0;
  t.encodings_named <- 0;
  t.encoding_named <- 0

let[@inline] end_parameter t =
  let n = t.parameter in
  t.parameter <- -1;
  if t.private_marker && n >= 0 then (
    t.flags_named <- t.flags_named lor flag_of_mode n;
    if is_tracking n then t.tracking_named <- n;
    if encoding_bit n <> 0 then (
      t.encodings_named <- t.encodings_named lor encoding_bit n;
      t.encoding_named <- n))

let set_modes t =
  t.flags <- t.flags lor t.flags_named;
  if t.tracking_named <> 0 then t.tracking <- t.tracking_named;
  if t.encoding_named <> 0 then t.encoding <- t.encoding_named

let reset_modes t =
  t.flags <- t.flags land lnot t.flags_named;
  if t.tracking_named <> 0 then t.tracking <- 0;
  if t.encodings_named land encoding_bit t.encoding <> 0 then t.encoding <- 0

let dispatch t final =
  end_parameter t;
  t.phase <- ground;
  match (t.private_marker, t.intermediate, final) with
  | true, 0, 'h' -> set_modes t
  | true, 0, 'l' -> reset_modes t
  | false, 33 (* '!' *), 'p' ->
      t.flags <- t.flags land lnot soft_reset lor (default_flags land soft_reset)
  | _ -> ()

(* Bytes that end or restart any sequence, as in the VT500 parser. *)
let[@inline] interrupt t c =
  match c with
  | '\027' ->
      t.phase <- escape;
      true
  | '\024' | '\026' | '\128' .. '\255' ->
      t.phase <- ground;
      true
  | _ -> false

let[@inline] parameter_byte t c =
  match c with
  | '0' .. '9' when t.intermediate = 0 ->
      let digit = Char.code c - 48 in
      t.parameter <-
        (if t.parameter < 0 then digit
         else if t.parameter >= too_large then too_large
         else (t.parameter * 10) + digit)
  | ';' when t.intermediate = 0 -> end_parameter t
  | ':' when t.intermediate = 0 -> t.parameter <- too_large
  | '?' when (not t.started) && t.intermediate = 0 -> t.private_marker <- true
  | _ -> t.phase <- ignored_sequence

let[@inline] sequence_byte t c =
  if not (interrupt t c) then (
    (match c with
    | '\032' .. '\047' ->
        t.intermediate <- (if t.intermediate = 0 then Char.code c else -1)
    | '\048' .. '\063' -> parameter_byte t c
    | '\064' .. '\126' -> dispatch t c
    | _ ->
        (* C0 controls are executed, DEL ignored: the sequence goes on. *)
        ());
    t.started <- true)

let[@inline] ignored_byte t c =
  if not (interrupt t c) then
    match c with '\064' .. '\126' -> t.phase <- ground | _ -> ()

let[@inline] escape_byte t c =
  if not (interrupt t c) then
    match c with
    | '[' -> start_sequence t
    | 'c' ->
        full_reset t;
        t.phase <- ground
    | '=' ->
        t.flags <- t.flags lor keypad;
        t.phase <- ground
    | '>' ->
        t.flags <- t.flags land lnot keypad;
        t.phase <- ground
    | '\032' .. '\047' -> t.phase <- escape_intermediate
    | '\000' .. '\031' -> ()
    | _ -> t.phase <- ground

let[@inline] escape_intermediate_byte t c =
  if not (interrupt t c) then
    match c with '\048' .. '\126' -> t.phase <- ground | _ -> ()

let[@inline] step t c =
  let phase = t.phase in
  if phase = escape then escape_byte t c
  else if phase = control_sequence then sequence_byte t c
  else if phase = ignored_sequence then ignored_byte t c
  else escape_intermediate_byte t c

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
   then one. *)
let next_escape bytes i stop =
  let j = ref i in
  while !j + 8 <= stop && not (has_escape (unsafe_get_word bytes !j)) do
    j := !j + 8
  done;
  while !j < stop && Bytes.unsafe_get bytes !j <> '\027' do
    incr j
  done;
  !j

(* Outside a sequence only ESC matters: the loop looks for it and nothing
   else, a word at a time. *)
let feed t bytes offset length =
  if offset < 0 || length < 0 || offset > Bytes.length bytes - length then
    invalid_arg "Mesh_pty_modes.feed";
  let stop = offset + length in
  let i = ref offset in
  while !i < stop do
    if t.phase = ground then (
      let j = next_escape bytes !i stop in
      if j < stop then t.phase <- escape;
      i := j + 1)
    else (
      step t (Bytes.unsafe_get bytes !i);
      incr i)
  done

let feed_string t text =
  feed t (Bytes.unsafe_of_string text) 0 (String.length text)

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
