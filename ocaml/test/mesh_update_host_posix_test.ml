(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The cancellation of the update request under the eio_posix backend, the one
   Eio_main selects on macOS, on every platform: when the caller is cancelled
   (the host stops), [Mesh_update_host.run_curl] returns at once and the child
   is killed and reaped. With eio_posix the cancellation also ends the fiber
   that reaps the child, so a [run_curl] that awaited the exit status inside its
   own switch waited for ever. The run happens in a forked process with a
   watchdog, so that such a hang fails this test instead of blocking the
   suite. *)

let with_root f =
  let root = Filename.temp_file "mesh-update-posix" "" in
  Sys.remove root;
  Unix.mkdir root 0o700;
  Fun.protect
    ~finally:(fun () ->
      Array.iter
        (fun name -> Sys.remove (Filename.concat root name))
        (Sys.readdir root);
      Unix.rmdir root)
    (fun () -> f (Unix.realpath root))

(* A request that never answers; it writes its pid first. *)
let hanging_curl root =
  let path = Filename.concat root "curl" in
  Out_channel.with_open_bin path (fun channel ->
      output_string channel
        ("#!/bin/sh\necho $$ > '" ^ Filename.concat root "pid"
       ^ "'\nexec sleep 60\n"));
  Unix.chmod path 0o700;
  path

let read_pid root =
  let path = Filename.concat root "pid" in
  match In_channel.with_open_bin path In_channel.input_all with
  | text -> int_of_string_opt (String.trim text)
  | exception Sys_error _ -> None

(* [kill 0] succeeds on a zombie: after the reap the pid is gone. *)
let reaped pid =
  match Unix.kill pid 0 with
  | () -> false
  | exception Unix.Unix_error (Unix.ESRCH, _, _) -> true

(* Waits, at most 10 s, until the fake request runs (it has written its pid):
   on a loaded machine it may not have started after a fixed delay. *)
let rec wait_for_child ~mono ~root tries =
  if read_pid root = None && tries > 0 then (
    Eio.Time.Mono.sleep mono 0.05;
    wait_for_child ~mono ~root (tries - 1))

(* In the forked process: cancel a running request. Exit code 0 when the call
   returned within 5 s of the cancellation and the child is gone and reaped;
   3 when it was not reaped, 4 when it returned late, 6 when the request never
   started. *)
let cancel_under_posix ~curl ~root =
  Eio_posix.run @@ fun env ->
  let mono = Eio.Stdenv.mono_clock env in
  let started = ref infinity in
  Eio.Fiber.first
    (fun () ->
      ignore
        (Mesh_update_host.run_curl ~mgr:(Eio.Stdenv.process_mgr env)
           ~clock:mono ~seconds:60. [ curl; "-q" ]))
    (fun () ->
      wait_for_child ~mono ~root 200;
      started := Unix.gettimeofday ());
  let prompt = Unix.gettimeofday () -. !started < 5. in
  match read_pid root with
  | None -> 6
  | Some _ when not prompt -> 4
  | Some pid when reaped pid -> 0
  | Some _ -> 3

let watchdog = 20.

(* Waits for [pid] at most [watchdog] seconds; kills it after that. *)
let wait_or_kill pid =
  let deadline = Unix.gettimeofday () +. watchdog in
  let rec poll () =
    match Unix.waitpid [ Unix.WNOHANG ] pid with
    | 0, _ when Unix.gettimeofday () < deadline ->
        Unix.sleepf 0.05;
        poll ()
    | 0, _ ->
        Unix.kill pid Sys.sigkill;
        ignore (Unix.waitpid [] pid);
        None
    | _, status -> Some status
  in
  poll ()

let test_cancellation_returns_promptly () =
  with_root (fun root ->
      let curl = hanging_curl root in
      match Unix.fork () with
      | 0 ->
          let code =
            try cancel_under_posix ~curl ~root with _ -> 5
          in
          Unix._exit code
      | pid -> (
          match wait_or_kill pid with
          | None ->
              (* the fake request is already killed: only a zombie is left,
                 reaped by init once its parent is gone *)
              Alcotest.failf
                "run_curl did not return within %.0f s of the cancellation"
                watchdog
          | Some (Unix.WEXITED 0) -> ()
          | Some (Unix.WEXITED 3) ->
              Alcotest.fail "the request child was not reaped"
          | Some (Unix.WEXITED 4) ->
              Alcotest.fail "run_curl returned more than 5 s after the cancellation"
          | Some (Unix.WEXITED 6) ->
              Alcotest.fail "the fake request did not start within 10 s"
          | Some (Unix.WEXITED code) ->
              Alcotest.failf "the cancelled run failed (code %d)" code
          | Some (Unix.WSIGNALED signal | Unix.WSTOPPED signal) ->
              Alcotest.failf "the cancelled run died (signal %d)" signal))

let () =
  Alcotest.run "mesh_update_host_posix"
    [
      ( "eio_posix",
        [
          Alcotest.test_case "cancellation returns and reaps the child" `Quick
            test_cancellation_returns_promptly;
        ] );
    ]
