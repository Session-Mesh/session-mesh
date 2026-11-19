(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The agent side: Python's text and value semantics, agent detection, the
   shape of a session, the registry, and the row of a session. The expected
   values are Python's (discover.py), worked out by hand. *)

module Text = Mesh_python_text
module Py = Mesh_agent_py
module Session = Mesh_agent_session

let check_string = Alcotest.(check string)

(* Code points of valid UTF-8: the bytes that do not continue a sequence. *)
let code_points text = String.fold_left (fun n c -> if Char.code c land 0xc0 = 0x80 then n else n + 1) 0 text

let test_clip () =
  check_string "collapsed" "a b c" (Text.clip " a\t\n b\xc2\xa0\xe3\x80\x80c  ");
  let exact = String.concat "" (List.init 240 (fun _ -> "\xc3\xa9")) in
  check_string "240 code points kept" exact (Text.clip exact);
  let longer = exact ^ "x" in
  let expected = String.concat "" (List.init 239 (fun _ -> "\xc3\xa9")) ^ "\xe2\x80\xa6" in
  check_string "241 cut to 239 and an ellipsis" expected (Text.clip longer);
  check_string "choices at 40" "abcdefghijklmnopqrstuvwxyzabcdefghijklm\xe2\x80\xa6"
    (Text.clip ~max:40 "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz");
  check_string "invalid bytes replaced" "a\xef\xbf\xbdb" (Text.clip "a\xffb");
  check_string "strip" "x y" (Text.unicode_strip "\xe2\x80\xa8 x y\xc2\x85");
  check_string "lstrip" "<x " (Text.unicode_lstrip "\xc2\xa0<x ");
  check_string "prefix" "\xc3\xa9\xc3\xa9" (Text.prefix ~code_points:2 "\xc3\xa9\xc3\xa9\xc3\xa9")

let test_values () =
  let truthy = List.map Py.truthy [ `Null; `Bool false; `Int 0; `Float 0.; `String ""; `List []; `Assoc [] ] in
  Alcotest.(check (list bool)) "falsy" (List.init 7 (fun _ -> false)) truthy;
  Alcotest.(check bool) "truthy" true (Py.truthy (`String "0"));
  check_string "int" "5" (Py.str (`Int 5));
  check_string "float" "1.0" (Py.str (`Float 1.));
  check_string "fraction" "0.1" (Py.str (`Float 0.1));
  check_string "list" "['a', 1, True, None]" (Py.str (`List [ `String "a"; `Int 1; `Bool true; `Null ]));
  check_string "dict" "{'k': 'v'}" (Py.str (`Assoc [ ("k", `String "v") ]));
  Alcotest.(check bool) "last key wins" true (Py.get "a" (`Assoc [ ("a", `Int 1); ("a", `Int 2) ]) = `Int 2);
  Alcotest.(check bool) "or chain" true (Py.first_truthy [ `String ""; `Null; `Int 3 ] = `Int 3);
  Alcotest.(check bool) "or chain, last" true (Py.first_truthy [ `String ""; `Null ] = `Null)

let kind round pid = Option.bind (Mesh_agent_round.find round pid) (Session.kind_of round)

let test_detection () =
  let table =
    [
      Fake.process ~pid:10 ~sid:10 "claude";
      Fake.process ~pid:11 ~sid:11 "vibe-rs";
      Fake.process ~pid:12 ~sid:12 ~argv:[ "/usr/bin/node"; "/opt/pi-coding-agent/dist/cli.js" ] "node";
      Fake.process ~pid:13 ~sid:13 ~argv:[ "node"; "--max-old-space-size=4096"; "/usr/local/bin/gemini" ] "node";
      Fake.process ~pid:14 ~sid:14 ~argv:[ "/home/u/.local/bin/codex"; "resume" ] "MainThread";
      Fake.process ~pid:15 ~sid:15 ~argv:[ "node"; "server.js" ] "node";
      Fake.process ~pid:16 ~sid:16 "bash";
    ]
  in
  let round = Fake.round table in
  let kinds = List.map (kind round) [ 10; 11; 12; 13; 14; 15; 16 ] in
  Alcotest.(check (list (option string)))
    "kinds"
    [ Some "claude"; Some "vibe"; Some "pi"; Some "gemini"; Some "codex"; None; None ]
    kinds

let agent_pid frame = Option.map (fun ((process : Mesh_agent_round.process), _) -> process.pid) frame.Session.agent

let test_frame () =
  (* Session 20: a shell, a background claude (group 21) and a foreground codex (group 23). *)
  let table =
    [
      Fake.process ~pid:20 ~sid:20 ~tpgid:23 "bash";
      Fake.process ~pid:21 ~ppid:20 ~sid:20 ~pgrp:21 ~tpgid:23 "claude";
      Fake.process ~pid:22 ~ppid:21 ~sid:20 ~pgrp:21 ~tpgid:23 "claude";
      Fake.process ~pid:23 ~ppid:20 ~sid:20 ~pgrp:23 ~tpgid:23 "codex";
      Fake.process ~pid:30 ~sid:30 ~tpgid:99 "claude";
    ]
  in
  let round = Fake.round table in
  let frame = Session.frame round ~sid:20 in
  Alcotest.(check (option int)) "foreground agent first" (Some 23) (agent_pid frame);
  Alcotest.(check int) "foreground group" 23 frame.foreground;
  Alcotest.(check bool) "in the foreground" true (Session.agent_in_foreground frame);
  let lone = Session.frame round ~sid:30 in
  Alcotest.(check int) "unknown group: the session" 30 lone.foreground;
  Alcotest.(check bool) "not in the foreground" false (Session.agent_in_foreground lone);
  let gone = Session.frame round ~sid:40 in
  Alcotest.(check (option int)) "no session" None (agent_pid gone);
  (* Without the codex, the outer claude (21) is reported, not its helper (22). *)
  let round = Fake.round (List.filter (fun (p : Fake.process) -> p.pid <> 23) table) in
  Alcotest.(check (option int)) "helper skipped" (Some 21) (agent_pid (Session.frame round ~sid:20))

let test_registry () =
  let roots = Mesh_agent_roots.of_home "/nonexistent" in
  let claude () = Mesh_agent.adapter (module Mesh_agent_claude) roots in
  Alcotest.check_raises "duplicate" (Invalid_argument "Mesh_agent.Registry: two adapters for claude") (fun () ->
      ignore (Mesh_agent.Registry.create [ claude (); claude () ]));
  Alcotest.(check (list string)) "kinds" [ "claude" ] (Mesh_agent.Registry.kinds (Mesh_agent.Registry.create [ claude () ]));
  Alcotest.(check bool) "HOME required" true (Result.is_error (Mesh_agent_roots.of_environment (fun _ -> Some "")))

let member key = function `Assoc fields -> List.assoc key fields | _ -> `Null

let test_rows () =
  let long = String.concat " " (List.init 100 (fun _ -> "\xc3\xa9t\xc3\xa9")) in
  let table =
    [
      Fake.process ~pid:50 ~sid:50 ~argv:[ "vim"; long ] ~cwd:"/w" "vim";
      Fake.process ~pid:60 ~sid:60 ~argv:[] "kworker\xff";
      Fake.process ~pid:70 ~sid:70 ~argv:[ "codex"; "--yolo" ] ~cwd:"/c" "codex";
    ]
  in
  let round = Fake.round table and registry = Fake.registry "/nonexistent" in
  let row sid = Mesh_sessions_describe.row registry round ~sid in
  (match row 50 with
  | Described value ->
      let cmd = Option.get (Py.string (member "cmd" value)) in
      Alcotest.(check int) "cmd cut at 160 code points" 160 (code_points cmd)
  | Unsupported _ -> Alcotest.fail "vim");
  (match row 60 with
  | Described value -> Alcotest.(check bool) "empty argv: the name" true (member "cmd" value = `String "kworker\xef\xbf\xbd")
  | Unsupported _ -> Alcotest.fail "kworker");
  (match row 80 with
  | Described value -> Alcotest.(check bool) "gone" true (value = `Assoc [ ("cwd", `Null); ("cmd", `String "?"); ("agent", `Null) ])
  | Unsupported _ -> Alcotest.fail "gone");
  match row 70 with
  | Unsupported value ->
      let agent = member "agent" value in
      Alcotest.(check bool) "type" true (member "type" agent = `String "codex");
      Alcotest.(check bool) "argv" true (member "argv" agent = `List [ `String "codex"; `String "--yolo" ])
  | Described _ -> Alcotest.fail "codex has no adapter yet"

let () =
  Alcotest.run "mesh_agent"
    [
      ( "python",
        [ Alcotest.test_case "clip and strip" `Quick test_clip; Alcotest.test_case "values" `Quick test_values ] );
      ( "sessions",
        [
          Alcotest.test_case "detection" `Quick test_detection;
          Alcotest.test_case "frame" `Quick test_frame;
          Alcotest.test_case "registry" `Quick test_registry;
          Alcotest.test_case "rows" `Quick test_rows;
        ] );
    ]
