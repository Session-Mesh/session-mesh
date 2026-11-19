(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Request = Mesh_sessions_request

(* Tiers, the smallest served first: sessions their hooks report busy, then the rest. *)
module Queue = Mesh_priority.Make (String) (Int)

let busy_tier = 0
let other_tier = 1

let service (request : Request.t) =
  let queue = Queue.create () in
  List.iter
    (fun (session : Request.session) ->
      let tier = if session.busy then busy_tier else other_tier in
      Queue.add queue session.name (Queue.priority ~rank:(-.session.activity) tier) session)
    request.sessions;
  Queue.set_leading queue request.focus;
  List.map snd (Queue.to_list queue)

module Backoff = struct
  let strikes_to_wait = 3
  let rounds_to_wait = 3

  type entry = { created : Yojson.Safe.t; strikes : int; waiting : int }
  type t = (string, entry) Hashtbl.t

  let create () : t = Hashtbl.create 64

  let entry backoff (session : Request.session) =
    match Hashtbl.find_opt backoff session.name with
    | Some entry when entry.created = session.created -> entry
    | _ -> { created = session.created; strikes = 0; waiting = 0 }

  let avoid backoff sessions names =
    List.iter
      (fun (session : Request.session) ->
        if List.mem session.name names then
          Hashtbl.replace backoff session.name
            { created = session.created; strikes = strikes_to_wait; waiting = rounds_to_wait })
      sessions

  let admit backoff (session : Request.session) =
    let current = entry backoff session in
    if current.waiting = 0 then true
    else begin
      Hashtbl.replace backoff session.name { current with waiting = current.waiting - 1 };
      false
    end

  let ready backoff (session : Request.session) = Hashtbl.remove backoff session.name

  let slow backoff (session : Request.session) =
    let current = entry backoff session in
    let strikes = current.strikes + 1 in
    let waiting = if strikes >= strikes_to_wait then rounds_to_wait else 0 in
    Hashtbl.replace backoff session.name { current with strikes; waiting };
    if waiting > 0 then `Backoff else `Slow

  let retain backoff sessions = Request.retain_listed backoff sessions
end
