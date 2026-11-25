(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)

open Conversation_registry_model

let max_entries = 500
let keep_seconds = 90. *. 86400.

let normalize_text text =
  let limit = 60 in
  let result = Buffer.create limit in
  let length = String.length text in
  let rec add index count pending_space =
    if index = length then Buffer.contents result
    else
      let decoded = String.get_utf_8_uchar text index in
      let emit width =
        let count =
          if pending_space && count < limit then (
            Buffer.add_char result ' ';
            count + 1)
          else count
        in
        if count = limit then add (index + width) count false
        else (
          Buffer.add_substring result text index width;
          add (index + width) (count + 1) false)
      in
      if not (Uchar.utf_decode_is_valid decoded) then ""
      else
        let width = Uchar.utf_decode_length decoded in
        let character = Uchar.utf_decode_uchar decoded in
        let code = Uchar.to_int character in
        if code <= 0x1f || (code >= 0x7f && code <= 0x9f)
           || (code >= 0x202a && code <= 0x202e)
           || (code >= 0x2066 && code <= 0x2069)
        then add (index + width) count pending_space
        else if Uucp.White.is_white_space character then
          add (index + width) count (count > 0)
        else emit width
  in
  add 0 0 false

let text = function `String value -> normalize_text value | _ -> ""

let bound_agent = function
  | "claude" -> Some Claude
  | "codex" -> Some Codex
  | "pi" -> Some Pi
  | _ -> None

let alphanumeric = function 'a'..'z' | 'A'..'Z' | '0'..'9' -> true | _ -> false

let valid_sid sid =
  let length = String.length sid in
  length >= 8 && length <= 64 && alphanumeric sid.[0]
  && String.for_all (fun char -> char = '-' || alphanumeric char) sid

let binding agent sid =
  match agent, sid with
  | `Null, `Null -> Some Unbound
  | `String agent, `Null ->
      Option.map (fun agent -> Agent_only agent) (bound_agent agent)
  | `String agent, `String sid when valid_sid sid ->
      Option.map (fun agent -> Exact {agent; sid}) (bound_agent agent)
  | _ -> None

exception Timestamp_out_of_range

let timestamp value =
  match value, timestamp_of_json value with
  | `Intlit _, None -> raise Timestamp_out_of_range
  | _, timestamp -> timestamp

let ( let* ) = Option.bind

let entry_of_json : Yojson.Safe.t -> entry option = function
  | `Assoc fields ->
      (* Python's JSON decoder uses the last value of a repeated key. *)
      let fields = List.rev fields in
      let find = Fun.flip List.assoc_opt fields in
      let get key = Option.value ~default:`Null (find key) in
      let name = text (get "name") in
      if name = "" then None
      else
        let* created = timestamp (get "created") in
        let* seen = timestamp (get "seen") in
        let* closed_at =
          match get "closed_at" with
          | `Null -> Some None
          | value -> Option.map Option.some (timestamp value)
        in
        let* binding = binding (get "agent") (get "sid") in
        let* aliases =
          match find "aliases" with
          | None -> Some []
          | Some (`List values) ->
              Some (bounded_aliases (Seq.map text (List.to_seq values)))
          | Some _ -> None
        in
        Some {incarnation = {name; created}; binding; label = text (get "label");
              aliases; seen; closed_at}
  | _ -> None

let entry_to_json entry : Yojson.Safe.t =
  let agent, sid =
    match entry.binding with
    | Unbound -> (`Null, `Null)
    | Agent_only agent -> (`String (agent_name agent), `Null)
    | Exact {agent; sid} -> (`String (agent_name agent), `String sid)
  in
  `Assoc
    [ "name", `String entry.incarnation.name;
      "created", timestamp_to_json entry.incarnation.created;
      "seen", timestamp_to_json entry.seen;
      "label", `String entry.label;
      "aliases", `List (List.map (fun alias -> `String alias) entry.aliases);
      "agent", agent;
      "sid", sid;
      "closed_at", Option.fold ~none:`Null ~some:timestamp_to_json entry.closed_at ]

let latest entries =
  List.stable_sort (fun a b -> compare_time b.seen a.seen) entries
  |> List.take max_entries

(* Yojson parses JSON escapes. Check that their decoded strings and keys
   contain Unicode scalar values as well. *)
let rec valid_unicode = function
  | `String text -> String.is_valid_utf_8 text
  | `List values -> List.for_all valid_unicode values
  | `Assoc fields ->
      List.for_all (fun (key, value) -> String.is_valid_utf_8 key && valid_unicode value) fields
  | _ -> true

let parse_json contents =
  let json = Yojson.Safe.from_string contents in
  if not (valid_unicode json) then raise (Yojson.Json_error "Invalid UTF-8");
  json

let decode_with_clock ~clock contents =
  try
    match parse_json contents with
    | `List values ->
        let now = clock () in
        List.take (2 * max_entries) values
        |> List.filter_map (fun value ->
            let* entry = entry_of_json value in
            let age = now -. time_as_float entry.seen in
            if 0. <= age && age < keep_seconds then Some entry else None)
        |> latest |> Option.some
    | _ -> None
  with Yojson.Json_error _ | Timestamp_out_of_range -> None

let decode ~now contents = decode_with_clock ~clock:(fun () -> now) contents

let encode entries =
  Yojson.Safe.to_string ~std:true (`List (List.map entry_to_json (latest entries)))
