(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The pure rules of Mesh_pty_agent_stop: what holds a session's terminal,
   when its agent is gone, and the SIGHUP then SIGKILL escalation, on
   hand-made process tables and a simulated clock. *)

module Stop = Mesh_pty_agent_stop

let process ?(state = 'S') ?(tpgid = 100) ~pid ~pgrp ?(sid = 100) comm :
    Mesh_platform.process =
  { pid; ppid = 1; pgrp; sid; tpgid; comm; state; incarnation = 1L }

let shell ?(tpgid = 100) () = process ~tpgid ~pid:100 ~pgrp:100 "bash"
let runs_claude (found : Mesh_platform.process) = found.comm = "claude"
let classify table = Stop.classify ~runs_agent:runs_claude ~leader:100 table

let show = function
  | Stop.Idle -> "idle"
  | Stop.Running group -> Printf.sprintf "running %d" group
  | Stop.Refused reason -> "refused " ^ reason

let check_foreground label expected table =
  Alcotest.(check string) label expected (show (classify table))

let foreground () =
  check_foreground "the shell at its prompt" "idle" [ shell () ];
  check_foreground "the agent's job holds the terminal" "running 200"
    [
      shell ~tpgid:200 ();
      process ~tpgid:200 ~pid:200 ~pgrp:200 "claude";
      process ~tpgid:200 ~pid:201 ~pgrp:200 "node";
    ];
  check_foreground "an agent child of a wrapper is enough" "running 200"
    [
      shell ~tpgid:200 ();
      process ~tpgid:200 ~pid:200 ~pgrp:200 "env-wrapper";
      process ~tpgid:200 ~pid:201 ~pgrp:200 "claude";
    ];
  check_foreground "another program in the foreground"
    "refused unsupported_foreground"
    [ shell ~tpgid:300 (); process ~tpgid:300 ~pid:300 ~pgrp:300 "vim" ];
  check_foreground "an agent in the background" "refused agent_not_foreground"
    [ shell (); process ~pid:200 ~pgrp:200 "claude" ];
  check_foreground "a second agent beside the foreground one"
    "refused agent_not_foreground"
    [
      shell ~tpgid:200 ();
      process ~tpgid:200 ~pid:200 ~pgrp:200 "claude";
      process ~tpgid:200 ~pid:300 ~pgrp:300 "claude";
    ];
  check_foreground "the agent of another session does not count" "idle"
    [ shell (); process ~sid:900 ~pid:901 ~pgrp:901 "claude" ];
  check_foreground "the leader is the agent" "refused no_shell"
    [ process ~pid:100 ~pgrp:100 "claude" ];
  check_foreground "the leader is gone" "refused process_scan_failed" [];
  check_foreground "no terminal" "refused no_terminal" [ shell ~tpgid:(-1) () ]

let gone () =
  let gone table =
    Stop.gone ~runs_agent:runs_claude ~leader:100 ~group:(Some 200) table
  in
  Alcotest.(check bool)
    "the shell holds the terminal, the group is empty" true
    (gone [ shell () ]);
  Alcotest.(check bool)
    "the job still holds the terminal" false
    (gone [ shell ~tpgid:200 () ]);
  Alcotest.(check bool)
    "a member of the group survives" false
    (gone [ shell (); process ~pid:202 ~pgrp:200 "sleep" ]);
  Alcotest.(check bool)
    "a zombie runs nothing" true
    (gone [ shell (); process ~state:'Z' ~pid:202 ~pgrp:200 "claude" ]);
  Alcotest.(check bool)
    "an agent left elsewhere in the session" false
    (gone [ shell (); process ~pid:300 ~pgrp:300 "claude" ]);
  Alcotest.(check bool) "no leader: never gone" false (gone [])

(* A simulated clock: [sleep] advances it; [stopped] is true from [at]. *)
let run ?(at = infinity) () =
  let clock = ref 0. and sent = ref [] in
  let outcome =
    Stop.stop Stop.default_timing
      ~signal:(fun signum -> sent := (signum, !clock) :: !sent)
      ~sleep:(fun seconds -> clock := !clock +. seconds)
      ~now:(fun () -> !clock)
      ~stopped:(fun () -> !clock >= at)
  in
  (outcome, List.rev !sent, !clock)

let signals sent =
  List.map
    (fun (signum, _) ->
      if signum = Sys.sighup then "HUP"
      else if signum = Sys.sigkill then "KILL"
      else string_of_int signum)
    sent

let escalation () =
  let outcome, sent, _ = run ~at:1. () in
  Alcotest.(check bool)
    "a job that ends on SIGHUP is stopped" true (outcome = `Stopped);
  Alcotest.(check (list string)) "SIGHUP only" [ "HUP" ] (signals sent);
  let outcome, sent, _ = run ~at:3.5 () in
  Alcotest.(check bool)
    "a job that ignores SIGHUP is killed" true (outcome = `Stopped);
  Alcotest.(check (list string))
    "SIGHUP then SIGKILL" [ "HUP"; "KILL" ] (signals sent);
  let killed_at = snd (List.nth sent 1) in
  Alcotest.(check bool)
    "SIGKILL only once the grace is over" true
    (killed_at >= Stop.default_timing.grace);
  let outcome, sent, clock = run () in
  Alcotest.(check bool)
    "a job that outlives SIGKILL: still running" true (outcome = `Still_running);
  Alcotest.(check (list string))
    "no third signal" [ "HUP"; "KILL" ] (signals sent);
  Alcotest.(check bool) "bounded below the 5 s a client waits" true (clock < 5.);
  let outcome, sent, _ = run ~at:0. () in
  Alcotest.(check bool) "already gone" true (outcome = `Stopped);
  Alcotest.(check (list string))
    "a SIGHUP is still sent, harmless" [ "HUP" ] (signals sent)

let () =
  Alcotest.run "pty_agent_stop"
    [
      ( "rules",
        [
          Alcotest.test_case "what holds the terminal" `Quick foreground;
          Alcotest.test_case "when the agent is gone" `Quick gone;
          Alcotest.test_case "SIGHUP, then SIGKILL, then give up" `Quick
            escalation;
        ] );
    ]
