(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** One JSON value per line, decoded and encoded with bounds, for text written
    by another program.

    Yojson has no depth limit: a line of a few megabytes of [\[] would exhaust
    memory in its recursive parser. {!decode} therefore checks the length and
    pre-scans the nesting depth (brackets and braces outside strings) before
    it parses. Objects then keep the {e last} value of a duplicated key, at
    the place of its first occurrence, as Python's [json.loads] does, so that
    [Yojson.Safe.Util.member] (which takes the first) gives Python's answer. *)

type limits = { max_bytes : int; max_depth : int }

val default_limits : limits
(** 1 MiB and 128 levels. *)

type error =
  | Too_large  (** Longer than [max_bytes]. *)
  | Too_deep  (** Nested deeper than [max_depth]. *)
  | Invalid of string  (** Not one JSON value (the parser's message). *)

val error_message : error -> string

val depth_within : max_depth:int -> string -> bool
(** The pre-scan alone: [true] when no point of the text is nested deeper
    than [max_depth] arrays and objects. Bytes inside strings, escaped quotes
    included, are not counted. It does not validate the JSON. *)

val keep_last_keys : Yojson.Safe.t -> Yojson.Safe.t
(** Recursively remove duplicated object keys, keeping the last value at the
    place of the first occurrence. *)

val decode : limits -> string -> (Yojson.Safe.t, error) result
(** Bounds, then [Yojson.Safe.from_string], then {!keep_last_keys}. Never
    raises. *)

val encode : max_bytes:int -> Yojson.Safe.t -> (string, error) result
(** Compact text without a newline (JSON strings escape theirs), or
    [Error Too_large]. *)
