(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Parity with the Python listing (docs/sessions-protocol.md, "Differences
   from the Python listing"): the rows of fixtures/claude/scenarios.json,
   computed here on a fictional process table shaped like the real processes
   that tests/mesh-sessions-claude-parity.test.ts starts for the Python side,
   must equal fixtures/claude/golden.json, which that test writes from
   discover.describe and checks. *)

module U = Yojson.Safe.Util

let fixtures = "fixtures/claude"

type node = { id : string; spec : Yojson.Safe.t; pid : int; children : node list }

(* The same numbering as the TS test: depth first, the leader 0. *)
let rec number label spec counter ~base =
  let index = !counter in
  incr counter;
  let children = match U.member "children" spec with `List items -> items | _ -> [] in
  let children = List.map (fun child -> number label child counter ~base) children in
  { id = Printf.sprintf "%s/%d" label index; spec; pid = base + index; children }

let rec nodes node = node :: List.concat_map nodes node.children

let processes ~root ~label leader =
  let rec build parent node =
    let comm = U.to_string (U.member "comm" node.spec) in
    let index = Option.get (String.index_opt node.id '/') in
    let directory = Printf.sprintf "%s/p/%s/%s" root label (String.sub node.id (index + 1) (String.length node.id - index - 1)) in
    let args = U.member "args" node.spec |> U.to_list |> List.map U.to_string in
    Fake.process ~pid:node.pid ~ppid:parent ~sid:leader.pid
      ~argv:([ "/bin/sh"; Filename.concat directory comm ] @ args)
      ~cwd:(Printf.sprintf "%s/work/%s" root label) comm
    :: List.concat_map (build node.pid) node.children
  in
  build 1 leader

let write_home ~home ~mtime session leader =
  List.iter
    (fun node ->
      match U.member "metadata" node.spec with
      | `Null -> ()
      | metadata ->
          let transcript =
            match U.member "transcript" session with
            | `String name -> Some (In_channel.with_open_bin (Filename.concat fixtures name) In_channel.input_all)
            | _ -> None
          in
          let project = U.to_string_option (U.member "project" session) in
          Fake.claude_home ~home ~pid:node.pid ~metadata ?project ?transcript ();
          (match (U.member "sessionId" metadata, project) with
          | `String id, Some project ->
              let path = String.concat "/" [ home; ".claude/projects"; project; id ^ ".jsonl" ] in
              if Sys.file_exists path then Unix.utimes path mtime mtime
          | _ -> ()))
    (nodes leader)

let replace_all ~sub ~by text =
  let length = String.length sub in
  let buffer = Buffer.create (String.length text) in
  let rec walk index =
    if index > String.length text - length then Buffer.add_string buffer (String.sub text index (String.length text - index))
    else if String.sub text index length = sub then (Buffer.add_string buffer by; walk (index + length))
    else (Buffer.add_char buffer text.[index]; walk (index + 1))
  in
  walk 0;
  Buffer.contents buffer

let rec normalize ~root ~ids = function
  | `String text -> `String (replace_all ~sub:root ~by:"$ROOT" text)
  | `List items -> `List (List.map (normalize ~root ~ids) items)
  | `Assoc fields ->
      `Assoc
        (List.map
           (fun (key, value) ->
             match (key, value) with
             | "pid", `Int pid when List.mem_assoc pid ids -> (key, `String (List.assoc pid ids))
             | _ -> (key, normalize ~root ~ids value))
           fields)
  | value -> value

let json = Alcotest.testable (fun format value -> Format.pp_print_string format (Yojson.Safe.pretty_to_string value)) ( = )

let test_golden () =
  Support.with_directory (fun temporary ->
      let root = Unix.realpath temporary in
      let home = Filename.concat root "home" in
      let scenarios = Yojson.Safe.from_file (Filename.concat fixtures "scenarios.json") in
      let mtime = U.to_number (U.member "mtime" scenarios) in
      let sessions = U.to_list (U.member "sessions" scenarios) in
      let leaders =
        List.mapi
          (fun index session ->
            let label = U.to_string (U.member "label" session) in
            let leader = number label (U.member "process" session) (ref 0) ~base:(1000 + (20 * index)) in
            write_home ~home ~mtime session leader;
            (label, leader))
          sessions
      in
      let table = List.concat_map (fun (label, leader) -> processes ~root ~label leader) leaders in
      let ids = List.concat_map (fun (_, leader) -> List.map (fun node -> (node.pid, node.id)) (nodes leader)) leaders in
      let round = Fake.round table and registry = Fake.registry home in
      List.iter (fun adapter -> Mesh_agent.prepare adapter round) (Mesh_agent.Registry.adapters registry);
      let rows =
        List.map
          (fun (label, leader) ->
            let row = Mesh_sessions_describe.row registry round (Fake.session leader.pid) in
            if Mesh_sessions_describe.supported row then (label, normalize ~root ~ids (Mesh_sessions_describe.json row))
            else Alcotest.failf "%s: unsupported" label)
          leaders
      in
      let golden = Yojson.Safe.from_file (Filename.concat fixtures "golden.json") in
      List.iter
        (fun (label, row) -> Alcotest.check json label (Fake.canonical (U.member label golden)) (Fake.canonical row))
        rows;
      Alcotest.(check int) "every golden row compared" (List.length (U.keys golden)) (List.length rows))

let () = Alcotest.run "mesh_sessions_parity" [ ("python", [ Alcotest.test_case "golden rows" `Quick test_golden ]) ]
