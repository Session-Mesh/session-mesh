(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)

open Conversation_registry_model

val normalize_text : string -> string
(** Remove registry controls, collapse Unicode whitespace, and retain at most
    60 code points. *)

val bound_agent : string -> agent option
val valid_sid : string -> bool

val entry_to_json : entry -> Yojson.Safe.t

val decode : now:float -> string -> entry list option
(** Load at most the first 1,000 candidates; retain up to 500 valid rows
    observed strictly less than 90 days ago, newest first with stable ties.
    Return [None] if the document is unreadable or an integer timestamp falls
    outside the supported range. A caller must preserve those bytes. *)

val decode_with_clock : clock:(unit -> float) -> string -> entry list option
(** Sample [clock] after reading and parsing an array, before filtering rows. *)

val encode : entry list -> string
(** Serialize the 500 newest entries with stable ties, without applying age
    filtering or changing values. *)

val parse_json : string -> Yojson.Safe.t
(** Use Yojson to parse and reject invalid Unicode strings and keys.
    Raise [Yojson.Json_error] on invalid input. *)
