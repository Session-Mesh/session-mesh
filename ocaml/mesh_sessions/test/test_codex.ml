(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The Codex adapter beyond the Python parity set: the command-line reader,
   the checks between sessions (Python's rules and decision I4), the rollout
   header cache, the incremental fold, the fail-closed process rules, the
   registry hook, and a round whose preparation is missing. *)

module Argv = Mesh_agent_codex_argv
module Checks = Mesh_session_checks
module Rollouts = Mesh_agent_codex_rollouts

let id_a = "019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a01"
let id_b = "019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a02"
let now = Float.round (Unix.gettimeofday ())
let btime = 1_700_000_000.

let test_argv () =
  let read = Argv.resumed_id in
  Alcotest.(check (option string)) "plain" (Some id_a) (read [ "codex"; "resume"; id_a ]);
  Alcotest.(check (option string)) "options before" (Some id_a) (read [ "/x/codex"; "-m"; "o3"; "--yolo"; "resume"; id_a; "--x" ]);
  Alcotest.(check (option string)) "attached value" (Some id_a) (read [ "codex"; "-cresume"; "resume"; id_a ]);
  Alcotest.(check (option string)) "value named resume" (Some id_a) (read [ "codex"; "--cd"; "resume"; "resume"; id_a ]);
  Alcotest.(check (option string)) "node entry" (Some id_a)
    (read [ "node"; "/usr/lib/node_modules/@openai/codex/bin/codex.js"; "resume"; id_a ]);
  Alcotest.(check (option string)) "npx" (Some id_a) (read [ "npx"; "-y"; "@openai/codex@0.1.2"; "resume"; id_a ]);
  List.iter
    (fun (label, words) -> Alcotest.(check (option string)) label None (read words))
    [
      ("unknown option", [ "codex"; "--new"; "resume"; id_a ]);
      ("upper case", [ "codex"; "resume"; String.uppercase_ascii id_a ]);
      ("--last", [ "codex"; "resume"; "--last" ]);
      ("dash dash", [ "codex"; "--"; "resume"; id_a ]);
      ("other launcher", [ "sh"; "codex"; "resume"; id_a ]);
      ("bad package", [ "npx"; "@openai/codex@1/2"; "resume"; id_a ]);
    ];
  Alcotest.(check bool) "a word names it, any case" true (Argv.may_name [ "x"; String.uppercase_ascii id_a ] id_a);
  Alcotest.(check bool) "an unreadable resume claims" true (Argv.may_name [ "codex"; "resume"; "--yolo"; id_b ] id_a);
  Alcotest.(check bool) "another id does not" false (Argv.may_name [ "codex"; "resume"; id_b ] id_a)

let claim ?(holds_open = false) key id source = { Checks.key; id; source; holds_open }
let verdicts = Alcotest.(list (pair string (of_pp (fun f v -> Format.pp_print_string f (match v with Checks.Keep -> "keep" | Drop -> "drop" | Contested -> "contested")))))

let test_checks () =
  let check label expected claims = Alcotest.check verdicts label expected (Checks.check claims) in
  check "guess loses to exact" [ ("g", Drop); ("e", Keep) ] [ claim "g" "x" Guessed; claim "e" "x" Open ];
  check "two guesses" [ ("a", Drop); ("b", Drop); ("c", Keep) ] [ claim "a" "x" Guessed; claim "b" "x" Guessed; claim "c" "y" Guessed ];
  check "launch dropped with all" [ ("l", Drop); ("o", Drop) ] [ claim "l" "x" Launch; claim "o" "x" Open ];
  check "observed collisions kept" [ ("a", Keep); ("b", Keep) ] [ claim "a" "x" Open; claim "b" "x" Open ];
  check "alone" [ ("l", Keep) ] [ claim "l" "x" Launch ];
  check "I4: chosen holds" [ ("c", Keep); ("h", Contested); ("o", Contested); ("g", Drop) ]
    [ claim "c" "x" (Registry Chosen); claim "h" "x" (Registry Hook); claim "o" "x" ~holds_open:true Open; claim "g" "x" Guessed ];
  check "I4: tie broken by holding" [ ("a", Contested); ("b", Keep) ]
    [ claim "a" "x" (Registry Hook); claim "b" "x" ~holds_open:true (Registry Hook) ];
  check "I4: unbroken tie" [ ("a", Contested); ("b", Contested) ]
    [ claim "a" "x" ~holds_open:true (Registry Observed); claim "b" "x" ~holds_open:true Open ]

let first_line id = Fake_codex.header ~id ~cwd:"/w"

let test_header_cache () =
  Support.with_directory (fun home ->
      let cache = Rollouts.create () and root = Filename.concat home ".codex" in
      let path = Fake_codex.write_rollout ~home ~name:"a" ~mtime:(now -. 10.) (String.sub (first_line id_a) 0 20) in
      let ids () = List.map (fun (r : Rollouts.rollout) -> r.header.id) (Rollouts.walk cache ~root ~now) in
      Alcotest.(check bool) "incomplete first line: unknown" true (ids () = [ `Null ]);
      Support.append_file path (String.sub (first_line id_a) 20 (String.length (first_line id_a) - 20));
      Alcotest.(check bool) "read again once complete" true (ids () = [ `String id_a ]);
      let read = (Rollouts.counters cache).headers_read in
      Support.append_file path "{\"type\":\"event_msg\",\"payload\":{}}\n";
      Alcotest.(check bool) "grown file: header kept" true (ids () = [ `String id_a ]);
      Alcotest.(check int) "not read again" read (Rollouts.counters cache).headers_read;
      let restored = Rollouts.create () in
      Rollouts.restore restored (Rollouts.entries cache);
      ignore (Rollouts.walk restored ~root ~now);
      Alcotest.(check int) "restored entries need no read" 0 (Rollouts.counters restored).headers_read;
      Unix.symlink path (Filename.concat (Filename.dirname path) "rollout-link.jsonl");
      Alcotest.(check int) "links are not rollouts" 1 (List.length (Rollouts.walk cache ~root ~now)))

let codex ?(ppid = 50) ?(argv = [ "codex" ]) ?(cwd = Some "/w") ?(files = Ok []) ?(age = 600.) pid =
  { Fake_codex.pid; ppid; sid = pid; comm = "codex"; start = now -. age; argv; cwd; files; zombie = false }

let shell = { (codex 50) with comm = "bash"; ppid = 1 }

(* The fields of each process after one round: prepare, describe, then the
   corrections of the cross-session check. *)
let describe ?(config = Fake_codex.config ~btime ~now) home processes pids =
  let round = Result.get_ok (Mesh_agent_round.read (Fake_codex.platform ~btime (shell :: processes))) in
  let adapter = Mesh_agent_codex.create_with config (Mesh_agent_roots.of_home home) in
  Mesh_agent_codex.prepare adapter round;
  let described =
    List.map
      (fun pid ->
        let process = Option.get (Mesh_agent_round.find round pid) in
        { Mesh_agent.session = Fake_codex.session pid; process; fields = Fake_codex.describe adapter round pid })
      pids
  in
  let corrected = Mesh_agent_codex.check adapter round described in
  List.map
    (fun (row : Mesh_agent.described) -> Option.value ~default:row.fields (List.assoc_opt row.session.name corrected))
    described

let source fields = List.assoc_opt "identity_source" fields

let test_fail_closed () =
  Support.with_directory (fun home ->
      ignore (Fake_codex.write_rollout ~home ~name:"a" ~mtime:(now -. 10.) (first_line id_a));
      let lone files = describe home [ codex 100; codex ~ppid:1 ~cwd:(Some "/") ~files 900 ] [ 100 ] in
      Alcotest.(check bool) "another user's codex holds nothing" true
        (source (List.hd (lone (Error Mesh_platform.Denied))) = Some (`String "cwd_unique"));
      Alcotest.(check bool) "an unreadable one blocks the guess" true
        (List.hd (lone (Error (Mesh_platform.Malformed "x"))) = []);
      let incomplete = Fake_codex.platform ~btime [ shell; codex 100 ] in
      let incomplete = { incomplete with scan = (fun () -> Result.map (fun s -> { s with Mesh_platform.skipped = 1 }) (incomplete.scan ())) } in
      let round = Result.get_ok (Mesh_agent_round.read incomplete) in
      let adapter = Mesh_agent_codex.create_with (Fake_codex.config ~btime ~now) (Mesh_agent_roots.of_home home) in
      Mesh_agent_codex.prepare adapter round;
      Alcotest.(check bool) "incomplete table: no guess" true
        (Fake_codex.describe adapter round 100 = []);
      let other = Result.get_ok (Mesh_agent_round.read (Fake_codex.platform ~btime [ shell; codex 100 ])) in
      Alcotest.(check bool) "unprepared round: no identity" true
        (Fake_codex.describe adapter other 100 = []))

let test_registry_hook () =
  Support.with_directory (fun home ->
      let held = Fake_codex.write_rollout ~home ~name:"a" ~mtime:(now -. 10.) (first_line id_a) in
      let registry (session : Mesh_agent.session) = if session.name = "s100" then Some (id_a, Checks.Chosen) else None in
      let config = { (Fake_codex.config ~btime ~now) with registry_lookup = registry } in
      let rows = describe ~config home [ codex 100; codex ~ppid:1 ~cwd:(Some "/") ~files:(Ok [ (3, held) ]) 200 ] [ 100; 200 ] in
      Alcotest.(check bool) "registered id, no heuristic" true
        (List.assoc_opt "session_id" (List.nth rows 0) = Some (`String id_a) && source (List.nth rows 0) = Some (`String "chosen"));
      Alcotest.(check bool) "the observer is contested" true
        (List.assoc_opt "session_id" (List.nth rows 1) = Some `Null && source (List.nth rows 1) = Some (`String "contested")))

let message i = Printf.sprintf {|{"type":"event_msg","payload":{"type":"agent_message","message":"reply %d"}}|} i ^ "\n"

let test_incremental () =
  Support.with_directory (fun home ->
      let path = Fake_codex.write_rollout ~home ~name:"a" ~mtime:(now -. 100.) (first_line id_a) in
      let processes = [ codex ~files:(Ok [ (3, path) ]) 100 ] in
      let round = Result.get_ok (Mesh_agent_round.read (Fake_codex.platform ~btime (shell :: processes))) in
      let adapter = Mesh_agent_codex.create_with (Fake_codex.config ~btime ~now) (Mesh_agent_roots.of_home home) in
      let rows () = Mesh_agent_codex.prepare adapter round; Fake_codex.describe adapter round 100 in
      for i = 1 to 5 do
        Support.append_file path (message i);
        ignore (rows ())
      done;
      let fresh = describe home processes [ 100 ] in
      Alcotest.(check bool) "pieces equal a cold read" true (rows () = List.hd fresh);
      Alcotest.(check bool) "said" true (List.assoc "said" (rows ()) = `String "reply 5");
      let counted = Mesh_agent_codex.counters adapter in
      Alcotest.(check (pair int int)) "one start, then appends" (1, 4) (counted.restarted, counted.appended))

let () =
  Alcotest.run "mesh_agent_codex"
    [
      ("argv", [ Alcotest.test_case "resume id" `Quick test_argv ]);
      ("checks", [ Alcotest.test_case "duplicate ids" `Quick test_checks ]);
      ("rollouts", [ Alcotest.test_case "header cache" `Quick test_header_cache ]);
      ( "identity",
        [ Alcotest.test_case "fail closed" `Quick test_fail_closed; Alcotest.test_case "registry hook" `Quick test_registry_hook ] );
      ("fold", [ Alcotest.test_case "incremental" `Quick test_incremental ]);
    ]
