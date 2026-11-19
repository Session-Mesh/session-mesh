(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Reading the arguments of a tool call. The input schemas already reject
    unknown fields and wrong types; these readers repeat the type checks so a
    handler never trusts the transport. *)

val field : Yojson.Safe.t -> string -> Yojson.Safe.t option
val string : Yojson.Safe.t -> string -> (string, Work_err.t) result
val opt_string : Yojson.Safe.t -> string -> (string option, Work_err.t) result
val opt_int : Yojson.Safe.t -> string -> (int option, Work_err.t) result
val opt_bool : Yojson.Safe.t -> string -> (bool option, Work_err.t) result

val strings : Yojson.Safe.t -> string -> (string list, Work_err.t) result
(** An absent field is the empty list. *)

val opt_strings : Yojson.Safe.t -> string -> (string list option, Work_err.t) result

val opt_assoc : Yojson.Safe.t -> string -> ((string * Yojson.Safe.t) list, Work_err.t) result
(** An object field as its members; absent is empty. *)

val strings_of : string -> Yojson.Safe.t -> (string list, Work_err.t) result
(** A JSON list of strings; the name is used in the error. *)

val limit : Yojson.Safe.t -> default:int -> max:int -> (int, Work_err.t) result
(** The [limit] field, between 1 and [max]. *)

val reject_unsafe_text : Yojson.Safe.t -> (unit, Work_err.t) result
(** [invalid_input] when any string of the arguments (or any field name) holds a
    control character other than newline and tab (C0, DEL, C1, so also
    carriage return and ESC), or an invisible or bidirectional character (see
    {!Work_text}); the error names the field. *)
