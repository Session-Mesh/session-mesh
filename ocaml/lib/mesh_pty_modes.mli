(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The terminal modes that a stream of program output leaves a terminal in, for
    the modes a late client cannot recover from a cut replay: the alternate
    screen (DEC private modes 47, 1047, 1049), mouse tracking (9, 1000, 1002,
    1003) and its encoding (1006, 1016; xterm.js ignores 1005 and 1015), focus
    reports (1004), bracketed paste (2004), autowrap (7), cursor visibility
    (25), application cursor keys (1) and the application keypad ([ESC =],
    [ESC >], mode 66). Alternate scroll (1007) is not followed: xterm.js 5.5
    does not implement it. A full reset ([ESC c], which leaves the cursor
    visibility as it was) and a soft reset ([CSI ! p]) are followed as xterm.js
    5.5 applies them, as are its limits: the first 32 parameters of a sequence,
    sub-parameters after [:] ignored.

    Inside an escape sequence the bytes go through the states of xterm.js's
    parser (CSI, OSC, DCS, SOS, PM and APC strings) after its UTF-8 decoding: a
    C0 control is executed without ending the sequence, an invalid byte is
    dropped, a character from U+00A0 ends a CSI, and the C1 controls encoded as
    UTF-8 (C2 80 to C2 9F) act as in xterm.js. Outside a sequence only ESC is
    looked for: a C1 control there (C2 9B for CSI) is not followed.

    The state is fixed-size: no buffer, no allocation while scanning. A sequence
    may be split across any number of [feed] calls, and any input, hostile or
    truncated, is scanned once in linear time. Only complete sequences change
    the modes. *)

type t

val create : unit -> t
(** A terminal at its defaults. *)

val feed : t -> Bytes.t -> int -> int -> unit
(** [feed t bytes offset length] scans [length] output bytes from [offset].
    Raises [Invalid_argument] when they are not within [bytes]. *)

val feed_string : t -> string -> unit
(** [feed] for a whole string. *)

val copy : t -> t

val finish_sequence : t -> Bytes.t -> int -> int -> int option
(** [finish_sequence t bytes offset length] feeds bytes from [offset] only while
    a sequence is under way: [Some n] when it ended after [n] bytes ([0] when
    none was under way), [None] when it is still under way after [length] bytes.
    The sequence may be a string (an OSC title, a DCS payload, an APC): its text
    is fed up to its terminator. An ESC, or a C1 control that starts a sequence
    (C2 then 90, 98, 9B, 9D, 9E or 9F), is not fed: it cancels or ends the
    sequence under way and starts one that the caller keeps. Raises
    [Invalid_argument] like [feed]. *)

val prefix : t -> string
(** The sequences that take a terminal from its defaults to the modes of [t]:
    the alternate screen first (as mode 1049), then every other mode that
    differs from its default. Empty when every mode is at its default. *)

val equal : t -> t -> bool
(** Same modes and same partial sequence under way. *)
