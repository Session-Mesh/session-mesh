(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Text operations of Python, as the Python components of the mesh apply
    them, so that the native programs read the same files and print the same
    messages. *)

val strip : string -> string
(** [str.strip()] on ASCII text: removes the space, [\t], [\n], [\r], [\x0b],
    [\x0c] and [\x1c] to [\x1f] at both ends. Non-ASCII whitespace is kept. *)

val repr : string -> string
(** [repr(str)] as the error messages show it: single quotes, or double quotes
    when the text holds a single quote and no double quote; backslash escapes
    for that quote, the backslash and the ASCII control characters. Bytes from
    0x80 are kept as they are. *)

(** {1 Unicode text}

    The functions below read their argument as UTF-8, by code point, and
    return valid UTF-8: an invalid byte sequence becomes U+FFFD. Whitespace is
    Python's [str.isspace]: U+0009 to U+000D, U+001C to U+0020, U+0085,
    U+00A0, U+1680, U+2000 to U+200A, U+2028, U+2029, U+202F, U+205F and
    U+3000. *)

val is_unicode_space : int -> bool
(** Whether a code point is Python whitespace. *)

val unicode_strip : string -> string
(** [str.strip()]. *)

val unicode_lstrip : string -> string
(** [str.lstrip()]. *)

val is_blank : string -> bool
(** [not text.strip()], without building the stripped text. *)

val lstrip_index : string -> int
(** The byte index where [text.lstrip()] starts: [text.lstrip().startswith(p)]
    is [String.starts_with ~prefix:p] at that index, for an ASCII [p]. *)

val collapse_spaces : string -> string
(** [" ".join(text.split())]. *)

val prefix : code_points:int -> string -> string
(** [text[:n]]. *)

val clip : ?max:int -> string -> string
(** The mesh's [_clip(text, n)] ([discover.py]): {!collapse_spaces}, then, when
    longer than [max] (default 240) code points, the first [max - 1] followed
    by an ellipsis (U+2026). *)
