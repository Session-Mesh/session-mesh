(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Live checks against the running kernel; only meaningful on Linux. *)

open Mesh_platform

let ok_or_fail = function
  | Ok value -> value
  | Error e -> Alcotest.fail (error_to_string e)

let test_process_self () =
  let self = ok_or_fail (process (Unix.getpid ())) in
  Alcotest.(check int) "pid" (Unix.getpid ()) self.pid;
  Alcotest.(check int) "ppid" (Unix.getppid ()) self.ppid;
  Alcotest.(check bool) "incarnation positive" true (self.incarnation > 0L)

let test_command_line_self () =
  let argv = ok_or_fail (command_line (Unix.getpid ())) in
  Alcotest.(check bool) "non-empty" true (argv <> [])

let test_snapshot_contains_self () =
  let processes = ok_or_fail (snapshot ()) in
  Alcotest.(check bool)
    "self present" true
    (List.exists (fun (p : process) -> p.pid = Unix.getpid ()) processes)

let test_working_directory_self () =
  Alcotest.(check string)
    "cwd"
    (Unix.realpath (Sys.getcwd ()))
    (ok_or_fail (working_directory (Unix.getpid ())))

let test_open_file_paths_self () =
  (* procfs reports the canonical path; the temp dir may be a symlink. *)
  let opened = Unix.realpath (Filename.temp_file "mesh-platform" ".txt") in
  let descriptor = Unix.openfile opened [ Unix.O_RDONLY ] 0 in
  Fun.protect
    ~finally:(fun () ->
      Unix.close descriptor;
      Sys.remove opened)
    (fun () ->
      let targets = ok_or_fail (open_file_paths (Unix.getpid ())) in
      Alcotest.(check bool)
        "temp file listed" true
        (List.exists (fun (_, target) -> target = opened) targets);
      Alcotest.(check bool)
        "all absolute" true
        (List.for_all (fun (_, target) -> target.[0] = '/') targets))

let test_capabilities () =
  let caps = capabilities () in
  Alcotest.(check bool) "process_table" true caps.process_table;
  Alcotest.(check bool) "foreground_agent" true caps.foreground_agent;
  Alcotest.(check bool) "open_file_paths" true caps.open_file_paths

let test_reaped_child_not_found () =
  let child =
    Unix.create_process "true" [| "true" |] Unix.stdin Unix.stdout Unix.stderr
  in
  ignore (Unix.waitpid [] child);
  match process child with
  | Error Not_found -> ()
  | Ok _ -> Alcotest.fail "reaped child still visible"
  | Error e -> Alcotest.fail (error_to_string e)

(* A child of a detached session has no controlling terminal; whichever way the
   test environment behaves, the answer is never a non-positive group. *)
let test_foreground_group_never_non_positive () =
  match foreground_process_group (Unix.getpid ()) with
  | Ok group -> Alcotest.(check bool) "positive" true (group > 0)
  | Error Not_found -> ()
  | Error e -> Alcotest.fail (error_to_string e)

let with_socket_dir action =
  let dir = Filename.temp_dir "mesh-platform-sock-" "" in
  Fun.protect
    ~finally:(fun () ->
      (try Sys.remove (Filename.concat dir "s") with Sys_error _ -> ());
      Unix.rmdir dir)
    (fun () -> action (Filename.concat dir "s"))

let bound_is path expected what =
  Alcotest.(check bool) what expected (ok_or_fail (unix_socket_bound path))

let test_socket_bound_listening () =
  with_socket_dir (fun path ->
      let server = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
      Fun.protect
        ~finally:(fun () -> Unix.close server)
        (fun () ->
          Unix.bind server (Unix.ADDR_UNIX path);
          Unix.listen server 1;
          bound_is path true "listening socket is bound"))

let test_socket_bound_stale_file () =
  with_socket_dir (fun path ->
      let server = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
      Unix.bind server (Unix.ADDR_UNIX path);
      Unix.listen server 1;
      Unix.close server;
      Alcotest.(check bool) "file remains" true (Sys.file_exists path);
      bound_is path false "socket file without a listener is not bound")

let test_socket_bound_never_bound () =
  with_socket_dir (fun path -> bound_is path false "unbound path")

let tests =
  [
    Alcotest.test_case "foreground group never non-positive" `Quick
      test_foreground_group_never_non_positive;
    Alcotest.test_case "process of self" `Quick test_process_self;
    Alcotest.test_case "command line of self" `Quick test_command_line_self;
    Alcotest.test_case "snapshot contains self" `Quick
      test_snapshot_contains_self;
    Alcotest.test_case "working directory of self" `Quick
      test_working_directory_self;
    Alcotest.test_case "open file paths of self" `Quick
      test_open_file_paths_self;
    Alcotest.test_case "capabilities" `Quick test_capabilities;
    Alcotest.test_case "socket: listening is bound" `Quick
      test_socket_bound_listening;
    Alcotest.test_case "socket: stale file is not bound" `Quick
      test_socket_bound_stale_file;
    Alcotest.test_case "socket: never bound" `Quick
      test_socket_bound_never_bound;
    Alcotest.test_case "reaped child is Not_found" `Quick
      test_reaped_child_not_found;
  ]
