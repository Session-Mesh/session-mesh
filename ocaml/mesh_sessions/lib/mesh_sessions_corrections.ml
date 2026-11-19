(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Request = Mesh_sessions_request
module Describe = Mesh_sessions_describe

let digest row = Digest.string (Yojson.Safe.to_string (Describe.json row))

(* The last correction of a session: its incarnation, the row as described
   before the correction, and the fields the check gave. *)
type remembered = { created : Yojson.Safe.t; described : Digest.t; fields : Mesh_agent.fields }
type t = (string, remembered) Hashtbl.t

let create () = Hashtbl.create 16

let remembered table (session : Request.session) row =
  match Hashtbl.find_opt table session.name with
  | Some last when last.created = session.created && Digest.equal last.described (digest row) ->
      Describe.with_fields row last.fields
  | _ -> row

type outcome = { session : Request.session; described : Describe.t; correction : Mesh_agent.fields option }

let final outcome =
  match outcome.correction with Some fields -> Describe.with_fields outcome.described fields | None -> outcome.described

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
      match outcome.correction with
      | Some fields ->
          Hashtbl.replace table name
            { created = outcome.session.created; described = digest outcome.described; fields }
      | None -> Hashtbl.remove table name)
    outcomes

let retain table sessions = Request.retain_listed table sessions
