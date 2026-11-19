(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type session = {
  name : string;
  created : Yojson.Safe.t;
  pid : int;
  activity : float;
  busy : bool;
}

type t = { sessions : session list; focus : string list; full : bool; avoid : string list }

let max_sessions = 4096
let ( let* ) = Result.bind

let valid_name name =
  let ok = function 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '_' | '-' -> true | _ -> false in
  String.length name >= 1 && String.length name <= 48 && String.for_all ok name

let number = function
  | `Int value -> Some (float_of_int value)
  | `Float value when Float.is_finite value -> Some value
  | _ -> None

let field fields key = List.assoc_opt key fields

let identity get =
  match (get "name", get "created", get "pid") with
  | Some (`String name), Some created, Some (`Int pid)
    when valid_name name && number created <> None && pid >= 1 && pid <= 0x7fffffff ->
      Ok (name, created, pid)
  | _ -> Error "sessions: each needs a valid name, a numeric created and a positive pid"

let activity_of get =
  match get "activity" with
  | None -> Ok 0.
  | Some value -> Option.to_result ~none:"sessions: activity must be a number" (number value)

let busy_of get =
  match get "busy" with
  | None -> Ok false
  | Some (`Bool flag) -> Ok flag
  | Some _ -> Error "sessions: busy must be a boolean"

let session_of_json = function
  | `Assoc fields ->
      let get = field fields in
      let* name, created, pid = identity get in
      let* activity = activity_of get in
      let* busy = busy_of get in
      Ok { name; created; pid; activity; busy }
  | _ -> Error "sessions: each must be an object"

(* The names in their order, each at its first place. *)
let dedup names =
  let seen = Hashtbl.create 16 in
  List.filter
    (fun name ->
      let fresh = not (Hashtbl.mem seen name) in
      Hashtbl.replace seen name ();
      fresh)
    names

let unique sessions =
  let names = List.map (fun session -> session.name) sessions in
  List.compare_lengths (dedup names) names = 0

let sessions_of = function
  | Some (`List items) when List.length items <= max_sessions ->
      let* sessions =
        List.fold_left
          (fun acc item ->
            let* sessions = acc in
            let* session = session_of_json item in
            Ok (session :: sessions))
          (Ok []) items
      in
      let sessions = List.rev sessions in
      if unique sessions then Ok sessions else Error "sessions: names must be unique"
  | Some (`List _) -> Error "sessions: too many"
  | _ -> Error "sessions: a list is required"

let names_of key = function
  | None -> Ok []
  | Some (`List items) when List.length items <= max_sessions ->
      Ok (List.filter_map (function `String name when valid_name name -> Some name | _ -> None) items)
  | Some _ -> Error (key ^ ": a list of names is expected")

let parse fields =
  let* sessions = sessions_of (field fields "sessions") in
  let* focus = names_of "focus" (field fields "focus") in
  let* avoid = names_of "avoid" (field fields "avoid") in
  let* full =
    match field fields "full" with
    | None -> Ok false
    | Some (`Bool flag) -> Ok flag
    | Some _ -> Error "full: a boolean is expected"
  in
  let names = Hashtbl.create (List.length sessions) in
  List.iter (fun session -> Hashtbl.replace names session.name ()) sessions;
  let listed = Hashtbl.mem names in
  Ok { sessions; focus = dedup (List.filter listed focus); full; avoid = dedup avoid }
