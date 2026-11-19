(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Round = Mesh_sessions_round
module U = Yojson.Safe.Util

let session ?(activity = 0.) ?(busy = false) name pid =
  `Assoc [ ("name", `String name); ("created", `Float 1.5); ("pid", `Int pid); ("activity", `Float activity); ("busy", `Bool busy) ]

let request ?(focus = []) ?(full = false) ?(avoid = []) sessions =
  let names = List.map (fun name -> `String name) in
  match
    Mesh_sessions_request.parse
      [ ("sessions", `List sessions); ("focus", `List (names focus)); ("full", `Bool full); ("avoid", `List (names avoid)) ]
  with
  | Ok parsed -> parsed
  | Error message -> failwith message

let with_engine ?(config = Round.config ()) ?(home = "/nonexistent") ?(registry = Fake.registry home) platform f =
  Eio_main.run (fun env -> f (Round.create ~clock:(Eio.Stdenv.clock env) config platform registry))

let round ?(emit = fun _ _ -> Ok ()) engine parsed =
  let events = ref [] in
  let emit name fields =
    match emit name fields with
    | Ok () ->
        events := (name, `Assoc fields) :: !events;
        Ok ()
    | Error _ as refused -> refused
  in
  let final = Round.round engine parsed ~emit in
  (List.rev_map snd !events, `Assoc final)

let names events = List.map (fun event -> U.to_string (U.member "name" event)) events
let event_of name events = List.find (fun e -> U.member "name" e = `String name) events
let state_of name events = U.to_string (U.member "state" (event_of name events))
let shells count = List.init count (fun index -> Fake.process ~pid:(100 + index) ~sid:(100 + index) ~argv:[ "sh" ] "sh")
let has_row event = U.member "row" event <> `Null
let is_same event = U.member "same" event = `Bool true

(* A codex adapter that sees the session it describes and, across sessions,
   keeps a shared id on the oldest session only. *)
module Checked = struct
  type t = unit

  let kind = "codex"
  let create _ = ()
  let prepare () _ = ()
  let resize () ~sessions:_ = ()

  let describe () _ (session : Mesh_agent.session) _ =
    [ ("session_id", `String "shared"); ("seen", `String session.name); ("created_seen", `Float session.created) ]

  let check () _ (rows : Mesh_agent.described list) =
    match List.sort (fun (a : Mesh_agent.described) b -> compare a.session.created b.session.created) rows with
    | [] -> []
    | _ :: newer ->
        let without_id (row : Mesh_agent.described) = ("session_id", `Null) :: List.remove_assoc "session_id" row.fields in
        List.map (fun (row : Mesh_agent.described) -> (row.session.name, without_id row)) newer
end
