(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Request = Mesh_sessions_request
module Describe = Mesh_sessions_describe

let digest row = Digest.string (Yojson.Safe.to_string (Describe.json row))

(* One key a check changed: its value before and after ([None]: absent). *)
type change = { key : string; before : Yojson.Safe.t option; after : Yojson.Safe.t option }

let keys fields = List.map fst fields

(* The keys whose value differs between the described fields and the
   corrected ones. *)
let patch_of described corrected =
  let keys = List.sort_uniq compare (keys described @ keys corrected) in
  List.filter_map
    (fun key ->
      let before = List.assoc_opt key described and after = List.assoc_opt key corrected in
      if before = after then None else Some { key; before; after })
    keys

(* The fields with the patch applied when every changed key still holds its
   value before; changed keys stay in place, added ones come last. *)
let apply patch fields =
  if not (List.for_all (fun change -> List.assoc_opt change.key fields = change.before) patch) then None
  else
    let replace (key, value) =
      match List.find_opt (fun change -> change.key = key) patch with
      | None -> Some (key, value)
      | Some change -> Option.map (fun after -> (key, after)) change.after
    in
    let added change =
      match change with
      | { before = None; after = Some after; key } -> Some (key, after)
      | _ -> None
    in
    let added = List.filter_map added patch in
    Some (List.filter_map replace fields @ added)

let fields_of row = Option.map (fun (_, (described : Mesh_agent.described)) -> described.fields) (Describe.agent row)

(* The row with the patch applied, when it applies. *)
let patched row patch =
  match fields_of row with
  | None -> None
  | Some fields -> Option.map (Describe.with_fields row) (apply patch fields)

(* The last correction of a session: its incarnation and the keys the check
   changed, with their values before and after. *)
type remembered = { created : Yojson.Safe.t; patch : change list }
type t = (string, remembered) Hashtbl.t

let create () = Hashtbl.create 16

let remembered table (session : Request.session) row =
  match Hashtbl.find_opt table session.name with
  | Some last when last.created = session.created -> Option.value ~default:row (patched row last.patch)
  | _ -> row

type outcome = { session : Request.session; described : Describe.t; correction : Mesh_agent.fields option }

let patch_of_outcome outcome =
  match (outcome.correction, fields_of outcome.described) with
  | Some corrected, Some described -> Some (patch_of described corrected)
  | _ -> None

(* The corrected row is the described row with the patch applied, so that
   it is byte-identical to the row a remembered patch gives. *)
let final outcome =
  match outcome.correction with
  | None -> outcome.described
  | Some fields -> (
      match Option.bind (patch_of_outcome outcome) (patched outcome.described) with
      | Some row -> row
      | None -> Describe.with_fields outcome.described fields)

(* The rows of one adapter's type, with what the adapter described. *)
let rows_of_kind kind rows =
  List.filter_map
    (fun (session, row) ->
      match Describe.agent row with
      | Some (row_kind, described) when row_kind = kind -> Some (session, row, described)
      | _ -> None)
    rows

let names_of rows = List.map (fun ((session : Request.session), _) -> session.name) rows

(* One adapter's check over its rows and the context; the outcomes of the
   rows only, none when the check raised, overran or found no thread. *)
let check_adapter ~run round adapter ~context rows =
  match rows_of_kind (Mesh_agent.kind adapter) rows with
  | [] -> []
  | mine -> (
      let requested = names_of rows in
      let others =
        List.filter (fun ((session : Request.session), _) -> not (List.mem session.name requested)) context
      in
      let checked = mine @ rows_of_kind (Mesh_agent.kind adapter) others in
      let described = List.map (fun (_, _, described) -> described) checked in
      match run (fun () -> Mesh_agent.check adapter round described) with
      | None -> []
      | Some changed ->
          List.map
            (fun (session, row, _) ->
              { session; described = row; correction = List.assoc_opt session.Request.name changed })
            mine)

let check ~run adapters round ?(context = []) rows =
  List.concat_map (fun adapter -> check_adapter ~run round adapter ~context rows) adapters

let remember table outcomes =
  List.iter
    (fun outcome ->
      let name = outcome.session.Request.name in
      match patch_of_outcome outcome with
      | Some patch -> Hashtbl.replace table name { created = outcome.session.created; patch }
      | None -> Hashtbl.remove table name)
    outcomes

let retain table sessions = Request.retain_listed table sessions
