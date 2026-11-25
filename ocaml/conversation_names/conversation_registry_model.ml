(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)
type timestamp = Int of int64 | Float of float

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

let time_as_float = function
  | Int value -> Int64.to_float value
  | Float value -> value

let compare_int_float integer floating =
  if floating >= 0x1p63 then -1
  else if floating < -0x1p63 then 1
  else
    let integral = Int64.of_float floating in
    let order = Int64.compare integer integral in
    if order <> 0 then order else Float.compare (Float.trunc floating) floating

let compare_time left right =
  match (left, right) with
  | Int a, Int b -> Int64.compare a b
  | Float a, Float b -> Float.compare a b
  | Int a, Float b -> compare_int_float a b
  | Float a, Int b -> -(compare_int_float b a)

let timestamp_of_json : Yojson.Safe.t -> timestamp option = function
  | `Int value -> Some (Int (Int64.of_int value))
  | `Intlit value -> Option.map (fun value -> Int value) (Int64.of_string_opt value)
  | `Float value when Float.is_finite value -> Some (Float value)
  | _ -> None

let timestamp_to_json : timestamp -> Yojson.Safe.t = function
  | Int value ->
      let native = Int64.to_int value in
      if Int64.of_int native = value then `Int native
      else `Intlit (Int64.to_string value)
  | Float value -> `Float value

let elapsed_day ~now ~seen =
  match now, seen with
  | Float _, _ | _, Float _ -> time_as_float now -. time_as_float seen >= 86_400.
  | Int now, Int seen ->
      seen <= Int64.sub Int64.max_int 86_400L
      && now >= Int64.add seen 86_400L

let same_incarnation a b =
  String.equal a.name b.name && compare_time a.created b.created = 0

let agent_name = function Claude -> "claude" | Codex -> "codex" | Pi -> "pi"

let bounded_aliases aliases =
  let limit = 20 in
  let seen = Hashtbl.create limit in
  let newest_first =
    Seq.fold_left
      (fun ordered alias ->
        if alias = "" || Hashtbl.mem seen alias then ordered
        else (
          Hashtbl.add seen alias ();
          alias :: ordered))
      [] aliases
  in
  List.rev (List.take limit newest_first)
