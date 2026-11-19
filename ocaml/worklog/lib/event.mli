(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** One line of the append-only event log: a JSON object with at least [ts],
    [task] and [type]. *)

type t = {
  ts : int;  (** epoch seconds, from the [ts] field *)
  task : string;
  typ : string;  (** the [type] field *)
  data : (string * Yojson.Safe.t) list;  (** every field of the line *)
  host : string;  (** host of the file the line was read from *)
  file : string;  (** file name, [YYYY-MM.<host>.jsonl] *)
  line : int;  (** 1-based line number in the file *)
}

val get : t -> string -> Yojson.Safe.t option
(** A field; the last one wins when a key is repeated. *)

val get_string : t -> string -> string option
(** A field that is a JSON string. *)

val compare : t -> t -> int
(** Fold order: [ts], then host (byte order), then file name, then line. *)

val where : t -> string
(** [file:line], for messages. *)

val classify : string -> ((string * Yojson.Safe.t) list * int, string) result
(** Parse one line without its newline: the fields and the timestamp, or the
    reason the line is malformed (blank, BOM, CRLF, not UTF-8, merge-conflict
    marker, invalid JSON, not an object, missing [ts]/[task]/[type], bad
    timestamp). *)

val encode : ts:int -> task:string -> typ:string -> (string * Yojson.Safe.t) list -> string
(** One compact JSON line (no newline): [ts], [task], [type], then the given
    fields in order. Non-ASCII text is written as UTF-8. *)
