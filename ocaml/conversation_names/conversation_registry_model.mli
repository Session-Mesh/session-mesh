(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)
type timestamp = Int of int64 | Float of float
(** Shared model for validated registry entries. Floats are finite and integer
    timestamps retain their signed 64-bit value. *)

type agent = Claude | Codex | Pi
type conversation = { agent : agent; sid : string }
type binding = Unbound | Agent_only of agent | Exact of conversation
type incarnation = { name : string; created : timestamp }

type entry = {
  incarnation : incarnation;
  binding : binding;
  label : string;
  aliases : string list;
  seen : timestamp;
  closed_at : timestamp option;
}


val compare_time : timestamp -> timestamp -> int
(** Compare by numeric value, preserving the precision of integer timestamps. *)

val timestamp_of_json : Yojson.Safe.t -> timestamp option
val timestamp_to_json : timestamp -> Yojson.Safe.t
val time_as_float : timestamp -> float
val elapsed_day : now:timestamp -> seen:timestamp -> bool
(** Whether the difference reaches one day, using exact integer subtraction
    when both timestamps are integers. *)

val same_incarnation : incarnation -> incarnation -> bool
val agent_name : agent -> string

val bounded_aliases : string Seq.t -> string list
(** Keep the last 20 distinct nonempty aliases in first-occurrence order. *)
