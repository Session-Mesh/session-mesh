(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Text rules of the data format: UTF-8 checks, whitespace, names, titles and
    file-name slugs. Lengths count Unicode code points. *)

val code_points : string -> int list option
(** The code points of a string, or [None] if it is not valid UTF-8. *)

val length : string -> int
(** Number of code points (bytes when the string is not valid UTF-8). *)

val is_blank : string -> bool
(** Empty or made of whitespace only (the Unicode whitespace of Python's
    [str.strip]). *)

val strip : string -> string
(** Remove leading and trailing whitespace (same set as {!is_blank}). *)

val has_control : string -> bool
(** Contains a control character, line or paragraph separator, or bidi control:
    U+0000-001F, U+007F-009F, U+2028, U+2029, U+202A-202E, U+2066-2069. *)

val valid_name : string -> bool
(** A product, category or [also] name: [[A-Za-z0-9][A-Za-z0-9._-]*], at most
    100 characters. *)

val name_chars_ok : string -> bool
(** The character rule of {!valid_name} without the length limit. *)

val title_error : string -> string option
(** Why a title is refused: empty, control characters, over 200 characters. *)

val text_error : field:string -> limit:int -> string -> string option
(** Non-empty, no control characters, at most [limit] characters (single-line
    labels and list items). *)

val body_text_error : what:string -> string -> string option
(** Event text: non-empty, valid UTF-8 without NUL, at most 8000 characters;
    newlines allowed. *)

val slugify : string -> string
(** File-name slug: ASCII lowercase, accents of Latin letters removed, other
    runs replaced by a single [-], trimmed, at most 40 characters; empty when
    nothing remains. *)

val first_line : ?limit:int -> string -> string option
(** First line of a text, stripped and cut to [limit] (default 80)
    characters; [None] when empty. *)
