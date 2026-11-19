(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Text safety: what may be stored in, and returned from, the data
    repository. Three classes are unwanted.

    - Invalid UTF-8 (a stray byte, a truncated or overlong sequence, an
      encoded surrogate): replaced by U+FFFD.
    - Control characters other than newline and tab: C0, DEL and C1.
    - Invisible and bidirectional characters that can hide text from a person
      or disguise a name while a model reads it: U+061C, U+200B, U+200E,
      U+200F, U+2028, U+2029, U+202A to U+202E, U+2060 to U+2064, U+2066 to
      U+2069, U+FEFF, U+FFF9 to U+FFFB and the tag block U+E0000 to U+E007F.
      U+200C and U+200D stay allowed: emoji sequences and some scripts need
      them. Other format characters (for example soft hyphen U+00AD, U+180E,
      variation selectors) are not covered. *)

type kind = Control | Invisible

val first_unsafe : string -> kind option
(** The class of the first control or invisible character of a string, if any.
    Invalid bytes are not reported here (see {!repair}). *)

val has_control : string -> bool
(** Contains a control character other than newline and tab. *)

val strip_controls : string -> string
(** Remove control characters only. *)

val repair : string -> string
(** Replace every invalid UTF-8 sequence by U+FFFD; a valid string is
    returned unchanged. *)

val clean : string -> string
(** {!repair}, then remove control and invisible characters, in one pass. The
    result is valid UTF-8 without any of the unwanted characters. *)
