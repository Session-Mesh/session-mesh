(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* 300 Codex sessions (a third holding their rollout open, a third launched
   with `codex resume <id>`, a third alone in their folder) with a 60 kB
   rollout each, beside 400 older rollouts: a round of the program under
   generous bounds (loaded CI machines; the times are printed), and a warm
   round that walks the rollouts once and decodes nothing. *)

module U = Yojson.Safe.Util

let sessions = 300
let now = Float.round (Unix.gettimeofday ())
let btime = 1_700_000_000.
let id i = Printf.sprintf "00000000-0000-4000-8000-%012d" i

let body =
  String.concat ""
    (List.init 120 (fun i ->
         Printf.sprintf {|{"type":"event_msg","payload":{"type":"agent_message","message":"reply %d %s"}}|} i (String.make 400 'r')
         ^ "\n"))

let fixture home =
  for i = 0 to 399 do
    ignore (Fake_codex.write_rollout ~home ~name:(Printf.sprintf "old-%d" i) ~mtime:(now -. 7200.) (Fake_codex.header ~id:(id (1000 + i)) ~cwd:"/elsewhere"))
  done;
  let shell = { Fake_codex.pid = 50; ppid = 1; sid = 50; comm = "bash"; start = now -. 9000.; argv = [ "bash" ]; cwd = Some "/"; files = Ok []; zombie = false; uid = Unix.getuid () } in
  shell
  :: List.init sessions (fun i ->
         let folder = Printf.sprintf "/w/f%d" i in
         let path = Fake_codex.write_rollout ~home ~name:(string_of_int i) ~mtime:(now -. 100.) (Fake_codex.header ~id:(id i) ~cwd:folder ^ body) in
         let argv = if i mod 3 = 1 then [ "codex"; "resume"; id i ] else [ "codex" ] in
         let files = Ok (if i mod 3 = 0 then [ (3, path) ] else []) in
         { shell with pid = 10_000 + i; ppid = 50; sid = 10_000 + i; comm = "codex"; start = now -. 3600.; argv; cwd = Some folder; files })

let request () =
  let session i =
    `Assoc [ ("name", `String (Printf.sprintf "s%d" i)); ("created", `Float 1.5); ("pid", `Int (10_000 + i)); ("activity", `Float (float i)) ]
  in
  Result.get_ok (Mesh_sessions_request.parse [ ("sessions", `List (List.init sessions session)) ])

let timed f = let started = Unix.gettimeofday () in let result = f () in (result, Unix.gettimeofday () -. started)

let round engine parsed =
  let events = ref [] in
  ignore (Mesh_sessions_round.round engine parsed ~emit:(fun _ fields -> events := `Assoc fields :: !events; Ok ()));
  !events

let identified event = U.member "session_id" (U.member "agent" (U.member "row" event)) <> `Null

let test_program_round () =
  Support.with_directory (fun home ->
      let platform = Fake_codex.platform ~btime (fixture home) in
      let adapter = Mesh_agent.adapter (Mesh_agent_codex.with_config (Fake_codex.config ~btime ~now)) (Mesh_agent_roots.of_home home) in
      let registry = Mesh_agent.Registry.create [ adapter ] in
      let config = Mesh_sessions_round.config ~deadline:30. ~setup_deadline:30. () in
      Eio_main.run (fun env ->
          let engine = Mesh_sessions_round.create ~clock:(Eio.Stdenv.clock env) config platform registry in
          let parsed = request () in
          let cold, cold_seconds = timed (fun () -> round engine parsed) in
          let warm, warm_seconds = timed (fun () -> round engine parsed) in
          Printf.printf "300 Codex sessions: cold round %.3f s, warm round %.3f s\n%!" cold_seconds warm_seconds;
          Alcotest.(check int) "every row" sessions (List.length cold);
          Alcotest.(check bool) "all ready and identified" true
            (List.for_all (fun e -> U.member "state" e = `String "ready" && identified e) cold);
          Alcotest.(check bool) "warm: all same" true (List.for_all (fun e -> U.member "same" e = `Bool true) warm);
          Alcotest.(check bool) "cold under 60 s" true (cold_seconds < 60.);
          Alcotest.(check bool) "warm under 10 s" true (warm_seconds < 10.)))

let test_warm_round () =
  Support.with_directory (fun home ->
      let platform = Fake_codex.platform ~btime (fixture home) in
      let adapter = Mesh_agent_codex.create_with (Fake_codex.config ~btime ~now) (Mesh_agent_roots.of_home home) in
      Mesh_agent_codex.resize adapter ~sessions;
      let describe_all () =
        let round = Result.get_ok (Mesh_agent_round.read platform) in
        Mesh_agent_codex.prepare adapter round;
        List.init sessions (fun i -> Fake_codex.describe adapter round (10_000 + i))
      in
      let first = describe_all () in
      let before = Mesh_agent_codex.counters adapter in
      let second = describe_all () in
      let after = Mesh_agent_codex.counters adapter in
      Alcotest.(check bool) "same rows" true (first = second);
      Alcotest.(check int) "cold: every header read once" (sessions + 400) before.headers_read;
      Alcotest.(check int) "one walk per round" (before.walks + 1) after.walks;
      Alcotest.(check int) "no header read" before.headers_read after.headers_read;
      Alcotest.(check (pair int int)) "no rollout decoded" (before.restarted, before.appended) (after.restarted, after.appended);
      Alcotest.(check int) "every rollout answered from the cache" (before.unchanged + sessions) after.unchanged)

let () =
  Alcotest.run "mesh_agent_codex_scale"
    [
      ( "scale",
        [ Alcotest.test_case "program round" `Quick test_program_round; Alcotest.test_case "warm round" `Quick test_warm_round ] );
    ]
