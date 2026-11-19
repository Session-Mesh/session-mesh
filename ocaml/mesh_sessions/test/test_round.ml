(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Rounds: order of service, rows sent as they end, a slow row that does not
   delay the others, backoff, saturation, same rows, describe, the request
   frames, and a 300-session round. Rounds run under Eio_main with the real
   clock, since rows run in system threads. *)

open Round_support

let test_order () =
  let parsed =
    request ~focus:[ "c"; "ghost"; "a" ]
      [ session "a" 1; session ~activity:5. "b" 2; session "c" 3; session ~busy:true "d" 4; session ~activity:9. "e" 5 ]
  in
  Alcotest.(check (list string)) "focus, busy, then by activity" [ "c"; "a"; "d"; "e"; "b" ]
    (List.map (fun (s : Mesh_sessions_request.session) -> s.name) (Mesh_sessions_order.service parsed));
  Alcotest.(check (list string)) "unknown focus names dropped" [ "c"; "a" ] parsed.focus

let test_stream_order () =
  let config = Round.config ~concurrency:1 () in
  with_engine ~config (Fake.platform (shells 4)) (fun engine ->
      let parsed = request ~focus:[ "s3" ] (List.init 4 (fun i -> session ~activity:(float i) (Printf.sprintf "s%d" i) (100 + i))) in
      let events, final = round engine parsed in
      Alcotest.(check (list string)) "served in order" [ "s3"; "s2"; "s1"; "s0" ] (names events);
      Alcotest.(check (list int)) "priorities" [ 0; 1; 2; 3 ] (List.map (fun e -> U.to_int (U.member "priority" e)) events);
      Alcotest.(check bool) "complete" true (U.member "complete" final = `Bool true))

(* Session 100's command line takes [seconds]; the others answer at once. *)
let slow_platform ?(seconds = 1.5) ?(count = 5) ?(slow = [ 100 ]) () =
  let reads = Atomic.make 0 in
  let on_read pid = if List.mem pid slow then (Atomic.incr reads; Unix.sleepf seconds) in
  (Fake.platform ~on_read (shells count), reads)

let test_slow_row () =
  let platform, _ = slow_platform () in
  with_engine ~config:(Round.config ~deadline:0.3 ~concurrency:4 ()) platform (fun engine ->
      let parsed = request ~focus:[ "s0" ] (List.init 5 (fun i -> session (Printf.sprintf "s%d" i) (100 + i))) in
      let started = Unix.gettimeofday () in
      let events, final = round engine parsed in
      let elapsed = Unix.gettimeofday () -. started in
      Alcotest.(check string) "first served, last reported" "s0" (List.nth (names events) 4);
      Alcotest.(check string) "slow" "slow" (state_of "s0" events);
      Alcotest.(check bool) "the others ready" true (List.for_all (fun n -> state_of n events = "ready") [ "s1"; "s2"; "s3"; "s4" ]);
      Alcotest.(check bool) "not waiting for the slow row" true (elapsed < 1.2);
      Alcotest.(check bool) "degraded names it" true
        (U.member "degraded" final |> U.member "avoid" = `List [ `String "s0" ]))

let test_backoff () =
  let platform, reads = slow_platform ~seconds:0.2 ~count:2 () in
  with_engine ~config:(Round.config ~deadline:0.05 ()) platform (fun engine ->
      let parsed = request [ session "s0" 100; session "s1" 101 ] in
      (* Each round waits for its abandoned threads, so that reads are counted per round. *)
      let reads_of_round () =
        let before = Atomic.get reads in
        let events, _ = round engine parsed in
        Unix.sleepf 0.6;
        (state_of "s0" events, Atomic.get reads > before)
      in
      let rounds = List.init 7 (fun _ -> reads_of_round ()) in
      Alcotest.(check (list string)) "slow, slow, then error"
        [ "slow"; "slow"; "error"; "error"; "error"; "error"; "error" ] (List.map fst rounds);
      Alcotest.(check (list bool)) "left alone three rounds, then tried"
        [ true; true; true; false; false; false; true ] (List.map snd rounds));
  let platform, reads = slow_platform ~seconds:0.2 ~count:2 () in
  with_engine platform (fun engine ->
      let events, _ = round engine (request ~avoid:[ "s0" ] [ session "s0" 100; session "s1" 101 ]) in
      Alcotest.(check string) "avoided" "error" (state_of "s0" events);
      Alcotest.(check int) "not tried" 0 (Atomic.get reads))

let test_saturation () =
  let platform, _ = slow_platform ~seconds:1. ~count:3 ~slow:[ 100; 101 ] () in
  with_engine ~config:(Round.config ~deadline:0.1 ~max_threads:2 ~concurrency:4 ()) platform (fun engine ->
      let parsed = request ~focus:[ "s0"; "s1"; "s2" ] [ session "s0" 100; session "s1" 101; session "s2" 102 ] in
      let events, final = round engine parsed in
      let reason = U.member "reason" (List.find (fun e -> U.member "name" e = `String "s2") events) in
      Alcotest.(check bool) "no thread left" true (reason = `String "saturated");
      Alcotest.(check bool) "abandoned threads reported" true (U.member "degraded" final |> U.member "abandoned" <> `Null);
      Alcotest.(check bool) "restart asked" true (U.member "degraded" final |> U.member "restart" = `Bool true);
      (* Every thread is still blocked: the next round has none for its table. *)
      let events, final = round engine parsed in
      let reasons = List.map (fun e -> U.member "reason" e) events in
      Alcotest.(check bool) "saturated, not a missing table" true (List.for_all (( = ) (`String "saturated")) reasons);
      Alcotest.(check int) "counted as errors" 3 (U.member "counts" final |> U.member "error" |> U.to_int);
      Alcotest.(check bool) "earlier slow names still avoided" true
        (U.member "degraded" final |> U.member "avoid" = `List [ `String "s0"; `String "s1" ]);
      Alcotest.(check bool) "restart still asked" true (U.member "degraded" final |> U.member "restart" = `Bool true));
  let failing = { (Fake.platform []) with scan = (fun () -> Error Mesh_platform.Denied) } in
  with_engine failing (fun engine ->
      let events, final = round engine (request [ session "s0" 100 ]) in
      Alcotest.(check bool) "no table" true (U.member "reason" (List.hd events) = `String "no_process_table");
      Alcotest.(check bool) "incomplete" true (U.member "complete" final = `Bool false))

let test_same_rows () =
  with_engine (Fake.platform (shells 3)) (fun engine ->
      let parsed = request (List.init 3 (fun i -> session (Printf.sprintf "s%d" i) (100 + i))) in
      let first, _ = round engine parsed in
      let second, _ = round engine parsed in
      let third, _ = round engine { parsed with full = true } in
      Alcotest.(check bool) "first: rows" true (List.for_all has_row first);
      Alcotest.(check bool) "second: same" true (List.for_all (fun e -> is_same e && not (has_row e)) second);
      Alcotest.(check bool) "full: rows" true (List.for_all has_row third);
      let rows = Round.describe engine parsed |> List.assoc "rows" |> U.to_list in
      Alcotest.(check (list string)) "describe: request order" [ "s0"; "s1"; "s2" ] (names rows);
      Alcotest.(check bool) "describe: rows" true (List.for_all has_row rows))

let frames input =
  let output = Buffer.create 256 in
  Eio_main.run (fun env ->
      Mesh_sessions_server.serve ~clock:(Eio.Stdenv.clock env) ~platform:(Fake.platform (shells 1))
        (Fake.registry "/nonexistent") (Eio.Flow.string_source input) (Eio.Flow.buffer_sink output));
  Buffer.contents output |> String.split_on_char '\n' |> List.filter (( <> ) "") |> List.map Yojson.Safe.from_string

let test_frames () =
  let replies =
    frames
      ({|{"req":1,"op":"hello"}|} ^ "\n" ^ {|{"req":2,"op":"round","sessions":[{"name":"a b","created":1,"pid":1}]}|} ^ "\n"
     ^ {|{"req":3,"op":"external"}|} ^ "\n" ^ {|{"req":4,"op":"round","sessions":[{"name":"s0","created":1,"pid":100}]}|} ^ "\n")
  in
  let final req = List.find (fun f -> U.member "req" f = `Int req && U.member "ok" f <> `Null) replies in
  let code req = U.member "error" (final req) |> U.member "code" in
  Alcotest.(check bool) "hello" true (U.member "adapters" (final 1) = `List [ `String "claude" ]);
  Alcotest.(check bool) "invalid name" true (code 2 = `String "bad_request");
  Alcotest.(check bool) "not in this version" true (code 3 = `String "unknown_op");
  Alcotest.(check bool) "row event" true
    (List.exists (fun f -> U.member "req" f = `Int 4 && U.member "event" f = `String "row") replies)

(* [count] Claude sessions in [home], each with a transcript of [lines]
   400-byte prompts; the fake process table that runs them. *)
let claude_sessions ~home ~lines count =
  let transcript =
    String.concat "" (List.init lines (fun i -> Printf.sprintf {|{"type":"user","message":{"content":"prompt %d %s"}}|} i (String.make 400 'p') ^ "\n"))
  in
  List.init count (fun i ->
      let pid = 10_000 + i in
      let id = Printf.sprintf "00000000-0000-4000-8000-%012d" i in
      Fake.claude_home ~home ~pid ~metadata:(`Assoc [ ("sessionId", `String id); ("status", `String "idle") ])
        ~project:(Printf.sprintf "-p%d" (i mod 40)) ~transcript ();
      Fake.process ~pid ~sid:pid ~cwd:"/w" "claude")

let claude_request count = request (List.init count (fun i -> session ~activity:(float i) (Printf.sprintf "s%d" i) (10_000 + i)))

(* 300 Claude sessions, each with a 60 kB transcript. The bounds are generous
   (loaded CI machines); the times are printed. *)
let test_scale () =
  Support.with_directory (fun home ->
      let table = claude_sessions ~home ~lines:120 300 in
      let config = Round.config ~deadline:30. ~setup_deadline:30. () in
      with_engine ~config ~home (Fake.platform table) (fun engine ->
          let parsed = claude_request 300 in
          let timed () = let started = Unix.gettimeofday () in let result = round engine parsed in (result, Unix.gettimeofday () -. started) in
          let (cold, _), cold_seconds = timed () in
          let (warm, _), warm_seconds = timed () in
          Printf.printf "300 sessions: cold round %.3f s, warm round %.3f s\n%!" cold_seconds warm_seconds;
          Alcotest.(check int) "cold: a row per session" 300 (List.length cold);
          Alcotest.(check int) "warm: a row per session" 300 (List.length warm);
          Alcotest.(check bool) "all ready" true (List.for_all (fun e -> U.member "state" e = `String "ready") cold);
          Alcotest.(check bool) "warm: all same" true (List.for_all is_same warm);
          Alcotest.(check bool) "cold under 60 s" true (cold_seconds < 60.);
          Alcotest.(check bool) "warm under 10 s" true (warm_seconds < 10.)))

(* The Claude adapter of a registry, kept to read its counters. *)
let counted_claude home =
  let state = ref None in
  let module Counted = struct
    include Mesh_agent_claude

    let create roots =
      let created = create roots in
      state := Some created;
      created
  end in
  let registry = Mesh_agent.Registry.create [ Mesh_agent.adapter (module Counted) (Mesh_agent_roots.of_home home) ] in
  (registry, fun () -> Mesh_agent_claude.counters (Option.get !state))

(* A describe of one session keeps the round's transcripts cached. *)
let test_describe_keeps_cache () =
  Support.with_directory (fun home ->
      let table = claude_sessions ~home ~lines:20 40 in
      let registry, counters = counted_claude home in
      let config = Round.config ~deadline:30. ~setup_deadline:30. () in
      with_engine ~config ~registry (Fake.platform table) (fun engine ->
          let parsed = claude_request 40 in
          ignore (round engine parsed);
          let decoded = (counters ()).restarted in
          ignore (Round.describe engine { parsed with sessions = [ List.hd parsed.sessions ] });
          let events, _ = round engine parsed in
          Alcotest.(check int) "first round decodes each transcript" 40 decoded;
          Alcotest.(check int) "no transcript decoded again" decoded (counters ()).restarted;
          Alcotest.(check bool) "all same" true (List.for_all is_same events)))

let test_check () =
  let table = [ Fake.process ~pid:100 ~sid:100 "codex"; Fake.process ~pid:101 ~sid:101 "codex" ] in
  let registry = Mesh_agent.Registry.create [ Mesh_agent.adapter (module Checked) (Mesh_agent_roots.of_home "/x") ] in
  let older = `Assoc [ ("name", `String "old"); ("created", `Float 1.); ("pid", `Int 100) ] in
  let newer = `Assoc [ ("name", `String "new"); ("created", `Float 2.); ("pid", `Int 101) ] in
  let agent event = U.member "row" event |> U.member "agent" in
  with_engine ~registry (Fake.platform table) (fun engine ->
      let events, final = round engine (request [ older; newer ]) in
      let last name = List.find (fun e -> U.member "name" e = `String name) (List.rev events) in
      Alcotest.(check int) "the corrected row is sent again" 3 (List.length events);
      Alcotest.(check bool) "describe sees the session" true (U.member "seen" (agent (last "old")) = `String "old");
      Alcotest.(check bool) "and its creation" true (U.member "created_seen" (agent (last "new")) = `Float 2.);
      Alcotest.(check bool) "oldest keeps the id" true (U.member "session_id" (agent (last "old")) = `String "shared");
      Alcotest.(check bool) "newer loses it" true (U.member "session_id" (agent (last "new")) = `Null);
      Alcotest.(check bool) "counted once" true (U.member "counts" final |> U.member "ready" = `Int 2);
      let rows = Round.describe engine (request [ older; newer ]) |> List.assoc "rows" |> U.to_list in
      Alcotest.(check bool) "describe: corrected" true (U.member "session_id" (agent (List.nth rows 1)) = `Null))

let () =
  Alcotest.run "mesh_sessions_round"
    [
      ( "order",
        [ Alcotest.test_case "service" `Quick test_order; Alcotest.test_case "stream" `Quick test_stream_order ] );
      ( "deadlines",
        [
          Alcotest.test_case "slow row" `Quick test_slow_row;
          Alcotest.test_case "backoff" `Quick test_backoff;
          Alcotest.test_case "saturation" `Quick test_saturation;
        ] );
      ( "protocol",
        [
          Alcotest.test_case "same rows" `Quick test_same_rows;
          Alcotest.test_case "frames" `Quick test_frames;
          Alcotest.test_case "describe keeps the cache" `Quick test_describe_keeps_cache;
          Alcotest.test_case "cross-session check" `Quick test_check;
        ] );
      ("scale", [ Alcotest.test_case "300 sessions" `Quick test_scale ]);
    ]
