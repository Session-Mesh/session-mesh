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
  | Error message -> Alcotest.fail message

let with_engine ?(config = Round.config ()) ?(home = "/nonexistent") platform f =
  Eio_main.run (fun env -> f (Round.create ~clock:(Eio.Stdenv.clock env) config platform (Fake.registry home)))

(* Run a round and return its events (in order) and final fields. *)
let round engine parsed =
  let events = ref [] in
  let emit name fields =
    events := (name, `Assoc fields) :: !events;
    Ok ()
  in
  let final = Round.round engine parsed ~emit in
  (List.rev_map snd !events, `Assoc final)

let names events = List.map (fun event -> U.to_string (U.member "name" event)) events
let state_of name events = U.to_string (U.member "state" (List.find (fun e -> U.member "name" e = `String name) events))
let shells count = List.init count (fun index -> Fake.process ~pid:(100 + index) ~sid:(100 + index) ~argv:[ "sh" ] "sh")

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
      Alcotest.(check bool) "abandoned threads reported" true (U.member "degraded" final |> U.member "abandoned" <> `Null));
  let failing = { (Fake.platform []) with scan = (fun () -> Error Mesh_platform.Denied) } in
  with_engine failing (fun engine ->
      let events, final = round engine (request [ session "s0" 100 ]) in
      Alcotest.(check bool) "no table" true (U.member "reason" (List.hd events) = `String "no_process_table");
      Alcotest.(check bool) "incomplete" true (U.member "complete" final = `Bool false))

let has_row event = U.member "row" event <> `Null
let is_same event = U.member "same" event = `Bool true

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

(* 300 Claude sessions, each with a 60 kB transcript. The bounds are generous
   (loaded CI machines); the times are printed. *)
let test_scale () =
  Support.with_directory (fun home ->
      let transcript =
        String.concat "" (List.init 120 (fun i -> Printf.sprintf {|{"type":"user","message":{"content":"prompt %d %s"}}|} i (String.make 400 'p') ^ "\n"))
      in
      let table =
        List.init 300 (fun i ->
            let pid = 10_000 + i in
            let id = Printf.sprintf "00000000-0000-4000-8000-%012d" i in
            Fake.claude_home ~home ~pid ~metadata:(`Assoc [ ("sessionId", `String id); ("status", `String "idle") ])
              ~project:(Printf.sprintf "-p%d" (i mod 40)) ~transcript ();
            Fake.process ~pid ~sid:pid ~cwd:"/w" "claude")
      in
      let config = Round.config ~deadline:30. ~setup_deadline:30. () in
      with_engine ~config ~home (Fake.platform table) (fun engine ->
          let parsed = request (List.init 300 (fun i -> session ~activity:(float i) (Printf.sprintf "s%d" i) (10_000 + i))) in
          let timed () = let started = Unix.gettimeofday () in let result = round engine parsed in (result, Unix.gettimeofday () -. started) in
          let (cold, _), cold_seconds = timed () in
          let (warm, _), warm_seconds = timed () in
          Printf.printf "300 sessions: cold round %.3f s, warm round %.3f s\n%!" cold_seconds warm_seconds;
          Alcotest.(check bool) "all ready" true (List.for_all (fun e -> U.member "state" e = `String "ready") cold);
          Alcotest.(check bool) "warm: all same" true (List.for_all is_same warm);
          Alcotest.(check bool) "cold under 60 s" true (cold_seconds < 60.);
          Alcotest.(check bool) "warm under 10 s" true (warm_seconds < 10.)))

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
        [ Alcotest.test_case "same rows" `Quick test_same_rows; Alcotest.test_case "frames" `Quick test_frames ] );
      ("scale", [ Alcotest.test_case "300 sessions" `Quick test_scale ]);
    ]
