(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Gitrun under a fake [git]: output cap, deadline after the output ends,
   a finished git whose grandchild keeps the pipe open, and a signal handler
   that raises while waiting. Each case leaves no child behind. *)

open Mesh_worklog
open Tutil

let with_script body f =
  let bin = temp_dir "grbin" in
  let script = Filename.concat bin "git" in
  write_file script ("#!/bin/sh\n" ^ body ^ "\n");
  Unix.chmod script 0o755;
  let old_path = Sys.getenv "PATH" in
  Unix.putenv "PATH" (bin ^ ":" ^ old_path);
  Fun.protect ~finally:(fun () -> Unix.putenv "PATH" old_path) f

let no_child_left () =
  match Unix.waitpid [ Unix.WNOHANG ] (-1) with
  | exception Unix.Unix_error (Unix.ECHILD, _, _) -> true
  | _ -> false

let timed f =
  let start = Lock.monotonic () in
  let r = f () in
  (r, Lock.monotonic () -. start)

(* Runs [f] with a SIGALRM handler [handler] armed to fire after one second. *)
let with_alarm handler f =
  let previous = Sys.signal Sys.sigalrm (Sys.Signal_handle (fun _ -> handler ())) in
  ignore (Unix.alarm 1);
  Fun.protect ~finally:(fun () -> ignore (Unix.alarm 0); Sys.set_signal Sys.sigalrm previous) f

let dir = lazy (temp_dir "grdir")

let test_output_cap () =
  with_script "head -c 17000000 /dev/zero | tr '\\000' x" (fun () ->
      let code, msg = Gitrun.run ~dir:(Lazy.force dir) [ "log" ] in
      Alcotest.(check int) "error exit code" 125 code;
      Alcotest.(check bool) "message names the cap" true
        (contains ~sub:(string_of_int Gitrun.max_output_bytes) msg);
      Alcotest.(check bool) "output not returned" true (String.length msg < 200);
      Alcotest.(check bool) "child reaped" true (no_child_left ()))

let test_output_under_the_cap () =
  with_script "head -c 3000000 /dev/zero | tr '\\000' x" (fun () ->
      let code, out = Gitrun.run ~dir:(Lazy.force dir) [ "log" ] in
      Alcotest.(check int) "exit code" 0 code;
      Alcotest.(check int) "all output" 3000000 (String.length out))

let test_break_propagates_after_reaping () =
  with_script "exec sleep 30" (fun () ->
      let (), seconds =
        timed (fun () ->
            match with_alarm (fun () -> raise Sys.Break) (fun () -> Gitrun.run ~dir:(Lazy.force dir) [ "log" ]) with
            | _ -> Alcotest.fail "Sys.Break was swallowed"
            | exception Sys.Break -> ())
      in
      Alcotest.(check bool) "returned at once, not after 30 s" true (seconds < 10.0);
      Alcotest.(check bool) "child reaped" true (no_child_left ()))

(* The output has ended (stdout closed), git is still running: the handler
   raises while the library waits for the exit. *)
let test_raising_handler_while_waiting_reaps () =
  with_script "exec 1>&- 2>&-\nexec sleep 4" (fun () ->
      let (code, _), seconds =
        timed (fun () ->
            with_alarm (fun () -> failwith "boom") (fun () -> Gitrun.run ~timeout:20.0 ~dir:(Lazy.force dir) [ "log" ]))
      in
      Alcotest.(check int) "converted to an error result" 125 code;
      Alcotest.(check bool) "returned at once" true (seconds < 3.5);
      Alcotest.(check bool) "child reaped, no zombie" true (no_child_left ()))

let test_deadline_applies_after_the_output_ends () =
  with_script "exec 1>&- 2>&-\nexec sleep 5" (fun () ->
      let (code, msg), seconds = timed (fun () -> Gitrun.run ~timeout:1.0 ~dir:(Lazy.force dir) [ "log" ]) in
      Alcotest.(check int) "timeout" 124 code;
      Alcotest.(check bool) "message" true (contains ~sub:"timed out" msg);
      Alcotest.(check bool) "after about 1 s, not 5 s" true (seconds < 3.0);
      Alcotest.(check bool) "child reaped" true (no_child_left ()))

(* git exits 0 after printing; a grandchild keeps the pipe open for 3 s. *)
let test_success_with_a_grandchild_holding_the_pipe () =
  with_script "echo hello\nsleep 3 &\nexit 0" (fun () ->
      let (code, out), seconds = timed (fun () -> Gitrun.run ~timeout:10.0 ~dir:(Lazy.force dir) [ "log" ]) in
      Alcotest.(check int) "exit status decides: success" 0 code;
      Alcotest.(check string) "output" "hello\n" out;
      Alcotest.(check bool) "not held until the grandchild ends" true (seconds < 2.0);
      Alcotest.(check bool) "child reaped" true (no_child_left ()))

let test_failure_with_a_grandchild_keeps_its_status () =
  with_script "echo bad\nsleep 3 &\nexit 7" (fun () ->
      let code, out = Gitrun.run ~timeout:10.0 ~dir:(Lazy.force dir) [ "log" ] in
      Alcotest.(check int) "exit status" 7 code;
      Alcotest.(check string) "output" "bad\n" out)

let test_catch_alls_reraise_fatal () =
  Alcotest.check_raises "Break" Sys.Break (fun () -> Err.reraise_fatal Sys.Break);
  Alcotest.check_raises "Out_of_memory" Out_of_memory (fun () -> Err.reraise_fatal Out_of_memory);
  Err.reraise_fatal (Failure "x")

let () =
  Alcotest.run "worklog gitrun"
    [ ( "gitrun",
        [ Alcotest.test_case "output cap" `Quick test_output_cap;
          Alcotest.test_case "under the cap" `Quick test_output_under_the_cap;
          Alcotest.test_case "Sys.Break propagates" `Quick test_break_propagates_after_reaping;
          Alcotest.test_case "raising handler reaps" `Quick test_raising_handler_while_waiting_reaps;
          Alcotest.test_case "deadline after output" `Quick test_deadline_applies_after_the_output_ends;
          Alcotest.test_case "grandchild, success" `Quick test_success_with_a_grandchild_holding_the_pipe;
          Alcotest.test_case "grandchild, failure" `Quick test_failure_with_a_grandchild_keeps_its_status;
          Alcotest.test_case "fatal exceptions" `Quick test_catch_alls_reraise_fatal ] ) ]
