(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Splits a byte stream into lines ended by ['\n'], with a bound on the line
    length, whatever the chunk boundaries.

    The splitter holds at most [max_line_bytes] bytes: a longer line is
    reported as {!Too_long} when its newline arrives, and its bytes are never
    kept. A last line without a newline stays pending (it may still be being
    written); {!pending_bytes} says how many bytes it holds so far.

    It is shared by the file tail ({!Mesh_jsonl_tail}) and the pipe protocol
    ({!Mesh_jsonl_rpc}), so both bound their lines the same way. *)

type line =
  | Line of string  (** A complete line, without its ['\n']. *)
  | Too_long  (** A complete line longer than the bound, dropped. *)

type start =
  | At_line_start
  | Skip_first_line
      (** Drop the bytes up to and including the first newline, silently: the
          reader started in the middle of a line (a tail window). *)
  | Inside_long_line
      (** Resume a stream that stopped in the middle of an over-long line: the
          bytes up to the first newline belong to it, and it is reported as
          {!Too_long} when that newline arrives. *)

type t

val create : ?start:start -> max_line_bytes:int -> unit -> t
(** @raise Invalid_argument if [max_line_bytes < 1]. *)

val feed : t -> bytes -> pos:int -> len:int -> (line -> unit) -> unit
(** Feed bytes; the callback receives each line completed by them, in order.
    When the callback runs, {!consumed} already counts the line and its
    newline. *)

val feed_string : t -> string -> (line -> unit) -> unit

val consumed : t -> int
(** Bytes fed so far up to and including the last newline. *)

val pending_bytes : t -> int
(** Bytes fed after the last newline. *)

val resume : t -> int * start
(** Where a later reader of the same stream starts, counted from the first
    byte fed, and in which mode. While a line of acceptable length is pending,
    it is {!consumed} with [At_line_start]: the pending bytes are read again.
    While the pending bytes belong to a line already dropped (too long, or the
    skipped first line), it is every byte fed, with [Inside_long_line] or
    [Skip_first_line], so that they are never read again. *)
