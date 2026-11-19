(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Parity with the Python listing for Codex: each scenario of
   fixtures/codex/scenarios.json, run through the Codex adapter on a
   fictional platform (Fake_codex), must give the agent fields of
   fixtures/codex/golden.json, which tests/mesh-sessions-codex-parity.test.ts
   writes from discover.codex_info and drop_duplicate_guessed_ids. *)

module U = Yojson.Safe.Util

let fixtures = "fixtures/codex"

let rec normalize ~root ~now = function
  | `String text -> `String (Fake_codex.replace_all ~sub:root ~by:"$ROOT" text)
  | `List items -> `List (List.map (normalize ~root ~now) items)
  | `Assoc fields ->
      `Assoc
        (List.map
           (fun (key, value) ->
             match (key, value) with
             | "updated", `Float mtime -> (key, `Float (Float.round ((mtime -. now) *. 1000.) /. 1000.))
             | _ -> (key, normalize ~root ~now value))
           fields)
  | value -> value

let json = Alcotest.testable (fun format value -> Format.pp_print_string format (Yojson.Safe.pretty_to_string value)) ( = )

(* The agent fields of each labelled process, as discover.codex_info gives them. *)
let rows spec name =
  Support.with_directory (fun temporary ->
      let root = Unix.realpath temporary and now = Float.round (Unix.gettimeofday ()) in
      let built = Fake_codex.build spec name ~root ~now in
      let round = Result.get_ok (Mesh_agent_round.read built.platform) in
      let adapter =
        Mesh_agent_codex.create_with (Fake_codex.config ~btime:(Fake_codex.btime spec) ~now) (Mesh_agent_roots.of_home built.home)
      in
      Mesh_agent_codex.prepare adapter round;
      List.map
        (fun (label, pid) ->
          let fields = Fake_codex.describe adapter round pid in
          (label, normalize ~root ~now (`Assoc (("type", `String "codex") :: fields))))
        built.labels)

let test_golden () =
  let spec = Fake_codex.load (Filename.concat fixtures "scenarios.json") in
  let golden = Yojson.Safe.from_file (Filename.concat fixtures "golden.json") in
  let names = Fake_codex.names spec in
  List.iter
    (fun name ->
      List.iter
        (fun (label, row) ->
          Alcotest.check json (name ^ "/" ^ label) (Fake.canonical (U.member label (U.member name golden))) (Fake.canonical row))
        (rows spec name))
    names;
  Alcotest.(check int) "every scenario compared" (List.length (U.keys golden)) (List.length names)

let () = Alcotest.run "mesh_sessions_codex_parity" [ ("python", [ Alcotest.test_case "golden rows" `Quick test_golden ]) ]
