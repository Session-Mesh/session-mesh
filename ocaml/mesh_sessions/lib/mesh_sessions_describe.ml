(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Round = Mesh_agent_round
module Session = Mesh_agent_session

type t = Described of Yojson.Safe.t | Unsupported of Yojson.Safe.t

let max_cmd = 160
let words round pid = List.map Session.argv_text (Round.argv round pid)

let cmd round (frame : Session.frame) =
  match Mesh_python_text.prefix ~code_points:max_cmd (String.concat " " (words round frame.foreground)) with
  | "" -> (
      match Round.find round frame.foreground with
      | Some process -> Session.name_text process.comm
      | None -> "?")
  | text -> text

let cwd round (frame : Session.frame) ~sid =
  let first = match frame.agent with Some (process, _) -> process.pid | None -> frame.foreground in
  (* A path is bytes: one that is not UTF-8 loses its invalid bytes, as argv does. *)
  let text path = `String (Session.argv_text path) in
  match Round.cwd round first with
  | Some path when path <> "" -> text path
  | _ -> ( match Round.cwd round sid with Some path -> text path | None -> `Null)

let agent registry round frame (process : Round.process) kind =
  let fields, described =
    match Mesh_agent.Registry.find registry kind with
    | Some adapter -> (Mesh_agent.describe adapter round process, true)
    | None -> ([], false)
  in
  let common =
    [
      ("pid", `Int process.pid);
      ("argv", `List (List.map (fun word -> `String word) (words round process.pid)));
      ("foreground", `Bool (Session.agent_in_foreground frame));
    ]
  in
  let fields = List.filter (fun (key, _) -> not (List.mem_assoc key common)) fields in
  (`Assoc ((("type", `String kind) :: fields) @ common), described)

let row registry round ~sid =
  let frame = Session.frame round ~sid in
  let agent, described =
    match frame.agent with
    | Some (process, kind) -> agent registry round frame process kind
    | None -> (`Null, true)
  in
  let row = `Assoc [ ("cwd", cwd round frame ~sid); ("cmd", `String (cmd round frame)); ("agent", agent) ] in
  if described then Described row else Unsupported row
