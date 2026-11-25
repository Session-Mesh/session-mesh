(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

open Conversation_registry_model

type row = (string * Yojson.Safe.t) list

let compare_seen a b = compare_time a.seen b.seen

let aliases entries =
  List.stable_sort compare_seen entries
  |> List.to_seq
  |> Seq.flat_map (fun entry -> List.to_seq entry.aliases)
  |> bounded_aliases

let json_aliases entries : Yojson.Safe.t =
  `List (List.map (fun alias -> `String alias) (aliases entries))

let matches_binding agent id = function
  | Unbound -> agent = `Null && id = `Null
  | Agent_only bound -> agent = `String (agent_name bound) && id = `Null
  | Exact bound -> agent = `String (agent_name bound.agent) && id = `String bound.sid

let set_field row (key, value) =
  if List.mem_assoc key row then
    List.map (fun (field, old) ->
      (field, if field = key then value else old)) row
  else row @ [ (key, value) ]

let enrich (item : row) entries =
  let agent = List.assoc "agent" item and id = List.assoc "id" item in
  let found =
    List.filter (fun entry -> matches_binding agent id entry.binding) entries
  in
  match found with
  | [] -> item
  | first :: rest ->
      let newest =
        List.fold_left
          (fun best entry -> if compare_seen entry best > 0 then entry else best)
          first rest
      in
      List.fold_left set_field item
        [ ("mesh_name", `String newest.incarnation.name);
          ("mesh_label", `String newest.label);
          ("mesh_aliases", json_aliases found) ]

let active_aliases entries (sessions : row list) =
  List.map (fun session ->
    let name = List.assoc "name" session in
    let found =
      match name, timestamp_of_json (List.assoc "created" session) with
      | `String name, Some created ->
          let incarnation = { name; created } in
          List.filter (fun entry -> same_incarnation incarnation entry.incarnation) entries
      | _ -> []
    in
    set_field session ("aliases", json_aliases found))
    sessions
