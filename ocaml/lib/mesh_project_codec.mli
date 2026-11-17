(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

exception Invalid of string

val config_bytes : int
val request_bytes : int
val reply_bytes : int
val operations : string list
val is_operation : string -> bool
val obj : Yojson.Basic.t -> (string * Yojson.Basic.t) list
val get : (string * Yojson.Basic.t) list -> string -> Yojson.Basic.t
val keys : (string * Yojson.Basic.t) list -> string list -> unit
val strict : Yojson.Basic.t -> unit
val text : ?empty:bool -> int -> Yojson.Basic.t -> string
val id : Yojson.Basic.t -> string
val uuid : Yojson.Basic.t -> string
val validate_config : Yojson.Basic.t -> Yojson.Basic.t
val parse_config : string -> Yojson.Basic.t
val parse_document : max_bytes:int -> string -> Yojson.Basic.t
val canonical : Yojson.Basic.t -> Yojson.Basic.t
val digest : string -> string
val encode : Yojson.Basic.t -> string
val normalized_create : Yojson.Basic.t -> Yojson.Basic.t
val patch : Yojson.Basic.t -> Yojson.Basic.t -> Yojson.Basic.t
