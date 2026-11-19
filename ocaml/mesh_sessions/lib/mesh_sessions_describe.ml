(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Round = Mesh_agent_round
module Session = Mesh_agent_session

type agent = {
  kind : string;
  common : (string * Yojson.Safe.t) list;  (* pid, argv, foreground *)
  described : Mesh_agent.described option;  (* None: no adapter for [kind] *)
}

type t = { cwd : Yojson.Safe.t; cmd : string; agent : agent option }

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

let agent registry round session frame (process : Round.process) kind =
  let described =
    Option.map
      (fun adapter -> { Mesh_agent.session; process; fields = Mesh_agent.describe adapter round session process })
      (Mesh_agent.Registry.find registry kind)
  in
  let common =
    [
      ("pid", `Int process.pid);
      ("argv", `List (List.map (fun word -> `String word) (words round process.pid)));
      ("foreground", `Bool (Session.agent_in_foreground frame));
    ]
  in
  { kind; common; described }

let row registry round (session : Mesh_agent.session) =
  let sid = session.pid in
  let frame = Session.frame round ~sid in
  let agent = Option.map (fun (process, kind) -> agent registry round session frame process kind) frame.agent in
  { cwd = cwd round frame ~sid; cmd = cmd round frame; agent }

let agent_json { kind; common; described } =
  let fields = match described with Some described -> described.fields | None -> [] in
  let fields = List.filter (fun (key, _) -> not (List.mem_assoc key common)) fields in
  `Assoc ((("type", `String kind) :: fields) @ common)

let json row =
  let agent = match row.agent with Some agent -> agent_json agent | None -> `Null in
  `Assoc [ ("cwd", row.cwd); ("cmd", `String row.cmd); ("agent", agent) ]

let supported row = match row.agent with Some { described = None; _ } -> false | _ -> true

let agent row =
  match row.agent with
  | Some { kind; described = Some described; _ } -> Some (kind, described)
  | _ -> None

let with_fields row fields =
  match row.agent with
  | Some ({ described = Some described; _ } as agent) ->
      { row with agent = Some { agent with described = Some { described with fields } } }
  | _ -> row
