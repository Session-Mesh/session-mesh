(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Two text operations of Python, as the Python components of the mesh apply
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
