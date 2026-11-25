(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)

open Conversation_registry_model
module Mutations = Conversation_mutations
module Projection = Mesh_conversation_names
module Store = Mesh_conversation_store

exception Invalid_request
exception Unsupported_version
exception Unreadable_registry

type operation =
  | Snapshot
  | Observe of { listed : bool; project : bool; sessions : Mutations.observation list }
  | Rename of incarnation * string * string
  | Close of incarnation
  | Forget of Yojson.Safe.t * Yojson.Safe.t
  | Last_label of Yojson.Safe.t * Yojson.Safe.t
  | Enrich of Yojson.Safe.t * Yojson.Safe.t

let invalid () = raise Invalid_request

let optional fields key = List.assoc_opt key fields
let default fields key = Option.value ~default:`Null (optional fields key)
let required fields key = match optional fields key with Some v -> v | None -> invalid ()

let string = function `String value -> value | _ -> invalid ()
let bool = function `Bool value -> value | _ -> invalid ()
let list = function `List values -> values | _ -> invalid ()

let timestamp value =
  match timestamp_of_json value with Some time -> time | None -> invalid ()

let text = function
  | `String value -> Conversation_codec.normalize_text value
  | _ -> ""

let fields = function `Assoc values -> values | _ -> invalid ()

let allow keys fields =
  let seen = Hashtbl.create (List.length keys) in
  List.iter
    (fun (key, _) ->
      if not (List.mem key keys) || Hashtbl.mem seen key then invalid ();
      Hashtbl.add seen key ())
    fields

let incarnation fields =
  {name = string (required fields "name"); created = timestamp (required fields "created")}

let identity = function
  | `Null -> Mutations.Shell
  | value ->
      let fields = fields value in
      allow ["type"; "session_id"; "identity_source"] fields;
      let agent =
        match default fields "type" with
        | `String name -> Conversation_codec.bound_agent name
        | _ -> None
      in
      let trusted =
        match default fields "identity_source" with
        | `String ("open_rollout" | "pid_metadata" | "unique_pi_transcript") -> true
        | _ -> false
      in
      match agent, trusted, default fields "session_id" with
      | Some agent, true, `String sid when Conversation_codec.valid_sid sid ->
          Mutations.Known {agent; sid}
      | Some _, false, _ -> Mutations.Ambiguous
      | _ -> Mutations.Shell

let observation value : Mutations.observation =
  let fields = fields value in
  allow ["name"; "created"; "label"; "agent"] fields;
  {incarnation = incarnation fields; label = text (default fields "label");
   identity = identity (default fields "agent")}

let parse request =
  let fields = fields request in
  (match required fields "version" with
   | `Int 1 -> ()
   | `Int _ | `Intlit _ -> raise Unsupported_version
   | _ -> invalid ());
  let op = string (required fields "op") in
  let allow names = allow ("version" :: "op" :: "now" :: "clock_now" :: names) fields in
  let operation =
    match op with
    | "snapshot" -> allow []; Snapshot
    | "observe" ->
        allow ["listed"; "project"; "sessions"];
        let enabled key = Option.fold ~none:true ~some:bool (optional fields key) in
        Observe {listed = enabled "listed"; project = enabled "project";
                 sessions = List.map observation (list (required fields "sessions"))}
    | "rename" ->
        allow ["name"; "created"; "old"; "new"];
        Rename (incarnation fields, text (required fields "old"), text (required fields "new"))
    | "close" -> allow ["name"; "created"]; Close (incarnation fields)
    | "forget" ->
        allow ["agent"; "sid"]; Forget (required fields "agent", required fields "sid")
    | "last_label" ->
        allow ["agent"; "sid"]; Last_label (required fields "agent", required fields "sid")
    | "enrich" ->
        allow ["agent"; "id"]; Enrich (required fields "agent", required fields "id")
    | _ -> invalid ()
  in
  let time key = Option.map timestamp (optional fields key) in
  (operation, time "now", time "clock_now")

let load clock = function
  | Store.Contents contents ->
      Conversation_codec.decode_with_clock ~clock:(fun () -> time_as_float (clock ())) contents
  | Store.Missing -> Some []
  | Store.Unreadable error -> raise (Unix.Unix_error (error, "read registry", ""))

let changes result =
  if result.Mutations.dirty then Some (Conversation_codec.encode result.entries)
  else None

let aliases entries (sessions : Mutations.observation list) =
  let rows =
    List.map
      (fun (session : Mutations.observation) ->
        let {name; created} = session.incarnation in
        ["name", `String name; "created", timestamp_to_json created])
      sessions
  in
  `List (List.map (List.assoc "aliases") (Projection.active_aliases entries rows))

let enriched agent id entries =
  Projection.enrich ["agent", agent; "id", id] entries
  |> List.filter (fun (field, _) -> field <> "agent" && field <> "id")

let forget entries agent sid =
  match agent, sid with
  | `String agent, `String sid ->
      (match Conversation_codec.bound_agent agent with
       | Some agent -> changes (Mutations.apply entries (Forget {agent; sid}))
       | None -> None)
  | _, `Null ->
      (* Older files can contain entries without a SID, including rows
         retaining an agent name. Python compared both fields as supplied. *)
      let kept =
        List.filter
          (fun entry ->
            match entry.binding with
            | Exact _ -> true
            | Unbound -> agent <> `Null
            | Agent_only bound -> agent <> `String (agent_name bound))
          entries
      in
      if List.length kept = List.length entries then None
      else Some (Conversation_codec.encode kept)
  | _ -> None

let run ~path ~now clock operation =
  let snapshot () =
    Store.transact ~path (fun source ->
        (Option.value ~default:[] (load clock source), None))
  in
  let update replacement =
    Store.transact ~path (fun source ->
        match load clock source with
        | Some entries -> ((), replacement entries)
        | None -> raise Unreadable_registry)
  in
  let mutate action = update (fun entries -> changes (Mutations.apply entries (action entries))) in
  match operation with
  | Snapshot -> `List (List.map Conversation_codec.entry_to_json (snapshot ()))
  | Observe {listed; project; sessions} ->
      if listed then (
        (* The observation starts before waiting for the lock. The original
           listing then takes a separate snapshot after the mutation commits. *)
        let now = match now with Some now -> now | None -> clock () in
        mutate (fun _ -> Observe {listed; now; sessions}));
      if project then aliases (snapshot ()) sessions else `Null
  | Rename (incarnation, old_label, new_label) ->
      mutate (fun entries ->
          (* A new incarnation gets a provisional timestamp that rename then
             replaces. The observable write uses the later clock sample. *)
          if not (List.exists (fun entry -> same_incarnation incarnation entry.incarnation) entries)
          then ignore (clock ());
          Rename {incarnation; now = clock (); old_label; new_label});
      `Null
  | Close incarnation ->
      mutate (fun _ -> Close {incarnation; now = clock ()});
      `Null
  | Forget (agent, sid) ->
      update (fun entries -> forget entries agent sid);
      `Null
  | Last_label (agent, sid) ->
      let fields = enriched agent sid (snapshot ()) in
      Option.value ~default:(`String "") (List.assoc_opt "mesh_label" fields)
  | Enrich (agent, id) -> `Assoc (enriched agent id (snapshot ()))

let response key value : Yojson.Safe.t = `Assoc ["version", `Int 1; key, value]
let error code = response "error" (`String code)

let execute ?(clock = Unix.gettimeofday) ~path request =
  try
    let operation, now, clock_now = parse request in
    let fixed_clock =
      match clock_now, operation with
      | None, Observe _ -> None
      | None, _ -> now
      | Some _, _ -> clock_now
    in
    let clock () =
      match fixed_clock with Some now -> now | None -> Float (clock ())
    in
    response "result" (run ~path ~now clock operation)
  with
  | Invalid_request -> error "invalid_request"
  | Unsupported_version -> error "unsupported_version"
  | Unreadable_registry -> error "registry_unreadable"
  | Unix.Unix_error _ | Sys_error _ -> error "registry_io"

let handle ?clock ~path request =
  let response =
    match Conversation_codec.parse_json request with
    | request -> execute ?clock ~path request
    | exception Yojson.Json_error _ -> error "invalid_request"
  in
  Yojson.Safe.to_string ~std:true response
