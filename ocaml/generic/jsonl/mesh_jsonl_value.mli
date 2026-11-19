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
    pre-scans the text ({!prescan}) before it parses. Objects then keep the
    {e last} value of a duplicated key, at the place of its first occurrence,
    as Python's [json.loads] does, so that [Yojson.Safe.Util.member] (which
    takes the first) gives Python's answer.

    {b Input policy}, chosen to match the Python readers this library ports
    ([history._feed] and [discover._tail_lines], both on [json.loads] in its
    default strict mode):
    - a comment ([/* */], [//]), which Yojson accepts and Python refuses, is
      refused: any ['/'] outside a string is;
    - a raw byte below [0x20] inside a string is refused (Python's strict
      mode); escaped ones ([\u0001]) are accepted;
    - text that is not UTF-8 is refused ({!Reject}, as [history._feed], whose
      [json.loads] on bytes raises), or first stripped of its invalid bytes
      ({!Drop}, as [discover._tail_lines], which decodes with
      [errors="ignore"]);
    - an escaped lone surrogate ([\ud800] without its low half, or a low
      half alone), which Yojson refuses and Python reads into a string that
      is not valid Unicode, is read as U+FFFD ({!replace_lone_surrogates}):
      the line is kept, the value stays valid UTF-8;
    - [NaN], [Infinity] and [-Infinity] are accepted, as Python does: they are
      values a fold may count or ignore. {!encode} refuses to write them.

    {b Output policy.} {!encode} never raises, and its [Ok] text is always
    one line of strict JSON in valid UTF-8: a non-finite float, a string that
    is not UTF-8, or a literal holding a newline gives [Error (Invalid _)]. *)

type invalid_utf8 =
  | Reject  (** A line that is not UTF-8 is [Invalid]. *)
  | Drop  (** Its invalid bytes are removed first (the maximal invalid subparts). *)

type limits = { max_bytes : int; max_depth : int; invalid_utf8 : invalid_utf8 }

val default_limits : limits
(** 1 MiB, 128 levels, {!Reject}. *)

type error =
  | Too_large  (** Longer than [max_bytes]. *)
  | Too_deep  (** Nested deeper than [max_depth]. *)
  | Invalid of string  (** Not one strict JSON value (the reason). *)

val error_message : error -> string

val prescan : max_depth:int -> string -> (unit, error) result
(** The pre-scan alone. [Error Too_deep] when a point of the text is nested
    deeper than [max_depth] arrays and objects; [Error (Invalid _)] on a ['/']
    outside a string or a raw byte below [0x20] inside one. Bytes inside
    strings, escaped quotes included, are not counted as brackets. It does not
    otherwise validate the JSON. *)

val drop_invalid_utf8 : string -> string
(** The text without its invalid UTF-8 sequences; valid text is returned as
    it is. *)

val replace_lone_surrogates : string -> string
(** The text with each escaped lone surrogate replaced by the escape of
    U+FFFD; an escaped pair is kept. Text without one is returned as it is. *)

val keep_last_keys : Yojson.Safe.t -> Yojson.Safe.t
(** Recursively remove duplicated object keys, keeping the last value at the
    place of the first occurrence. *)

val decode : limits -> string -> (Yojson.Safe.t, error) result
(** Length bound, UTF-8 policy, {!prescan}, {!replace_lone_surrogates}, then [Yojson.Safe.from_string],
    then {!keep_last_keys}. Never raises. *)

val encode : max_bytes:int -> Yojson.Safe.t -> (string, error) result
(** Compact text without a newline (JSON strings escape theirs), or
    [Error Too_large], or [Error (Invalid _)] for a value that has no strict
    JSON form (see the output policy). Never raises. *)
