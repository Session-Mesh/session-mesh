(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Live checks against the running macOS kernel. On any other system the suite
   is one skipped case that says why. *)

open Mesh_platform

let ok_or_fail what = function
  | Ok value -> value
  | Error e -> Alcotest.failf "%s: %s" what (error_to_string e)

let error_testable =
  Alcotest.testable
    (fun fmt e -> Format.pp_print_string fmt (error_to_string e))
    ( = )

let check_error what expected result =
  match result with
  | Ok _ -> Alcotest.failf "%s: expected %s" what (error_to_string expected)
  | Error found -> Alcotest.check error_testable what expected found

(* Poll [probe] until it answers [Some], for at most about two seconds. *)
let wait_for what probe =
  let rec loop attempts =
    match probe () with
    | Some value -> value
    | None when attempts = 0 -> Alcotest.failf "%s: timed out" what
    | None ->
        Unix.sleepf 0.02;
        loop (attempts - 1)
  in
  loop 100

let kill_and_reap pid =
  (try Unix.kill pid Sys.sigkill with Unix.Unix_error _ -> ());
  ignore (Unix.waitpid [] pid)

let with_child ?(env = Unix.environment ()) program argv action =
  let null = Unix.openfile "/dev/null" [ Unix.O_RDWR ] 0 in
  let pid =
    Fun.protect
      ~finally:(fun () -> Unix.close null)
      (fun () -> Unix.create_process_env program argv env null null null)
  in
  Fun.protect ~finally:(fun () -> kill_and_reap pid) (fun () -> action pid)

let now_microseconds () = Int64.of_float (Unix.gettimeofday () *. 1e6)

let test_process_self () =
  let self = ok_or_fail "self" (process (Unix.getpid ())) in
  Alcotest.(check int) "pid" (Unix.getpid ()) self.pid;
  Alcotest.(check int) "ppid" (Unix.getppid ()) self.ppid;
  Alcotest.(check char) "state" 'R' self.state;
  Alcotest.(check bool) "sid positive" true (self.sid > 0);
  Alcotest.(check bool) "pgrp positive" true (self.pgrp > 0);
  let executable = Filename.basename Sys.executable_name in
  Alcotest.(check bool)
    (Printf.sprintf "comm %S is a prefix of %S" self.comm executable)
    true
    (self.comm <> "" && String.starts_with ~prefix:self.comm executable);
  (* Microseconds since the epoch: started in the last hour, not later than
     now. *)
  let now = now_microseconds () in
  Alcotest.(check bool)
    "incarnation is a recent epoch time in microseconds" true
    (self.incarnation <= now && self.incarnation > Int64.sub now 3_600_000_000L)

let test_command_line_self () =
  Alcotest.(check (list string))
    "argv" (Array.to_list Sys.argv)
    (ok_or_fail "argv" (command_line (Unix.getpid ())))

let test_child_environment () =
  let key = "MESH_TEST_PROFILE_ROOT" and expected = "/tmp/test-profile" in
  let executable = Unix.realpath Sys.executable_name in
  let argv = [| executable; "--environment-fixture" |] in
  with_child
    ~env:[| key ^ "=" ^ expected; "MESH_TEST_OVERRIDE=present"; "MESH_TEST_EMPTY=" |]
    executable argv
    (fun child ->
      wait_for "exec test fixture" (fun () ->
          match command_line child with
          | Ok arguments when arguments = Array.to_list argv -> Some ()
          | _ -> None);
      let { incarnation; _ } = ok_or_fail "child" (process child) in
      let matches ?unset ~incarnation expected =
        darwin_process_environment_matches ?unset child ~incarnation ~key ~expected
      in
      Alcotest.(check bool) "expected profile" true
        (ok_or_fail "match" (matches ~incarnation expected));
      Alcotest.(check bool) "different profile" false
        (ok_or_fail "mismatch" (matches ~incarnation "/tmp/other"));
      Alcotest.(check bool) "present override refuses profile" false
        (ok_or_fail "override"
           (matches ~unset:[ "MESH_TEST_OVERRIDE" ] ~incarnation expected));
      Alcotest.(check bool) "empty and absent overrides allow profile" true
        (ok_or_fail "no override"
           (matches ~unset:[ "MESH_TEST_EMPTY"; "MESH_TEST_ABSENT" ] ~incarnation expected));
      check_error "wrong incarnation" Not_found
        (matches ~incarnation:(Int64.succ incarnation) expected))

let test_working_directory_self () =
  Alcotest.(check string)
    "cwd"
    (Unix.realpath (Sys.getcwd ()))
    (ok_or_fail "cwd" (working_directory (Unix.getpid ())))

let test_child () =
  with_child "/bin/sleep" [| "sleep"; "30" |] (fun child ->
      let found = ok_or_fail "child" (process child) in
      Alcotest.(check int) "ppid" (Unix.getpid ()) found.ppid;
      wait_for "exec" (fun () ->
          match command_line child with
          | Ok [ "sleep"; "30" ] -> Some ()
          | _ -> None);
      let asleep =
        wait_for "asleep" (fun () ->
            match process child with
            | Ok found when found.state = 'S' -> Some found
            | _ -> None)
      in
      Alcotest.(check string) "comm" "sleep" asleep.comm)

(* A child that calls setsid is the leader of its own session. *)
let test_session_id () =
  match Unix.fork () with
  | 0 -> (
      try
        ignore (Unix.setsid ());
        Unix.execv "/bin/sleep" [| "sleep"; "30" |]
      with _ -> Unix._exit 127)
  | child ->
      Fun.protect
        ~finally:(fun () -> kill_and_reap child)
        (fun () ->
          wait_for "setsid" (fun () ->
              match process child with
              | Ok found when found.sid = child -> Some ()
              | _ -> None);
          let found = ok_or_fail "leader" (process child) in
          Alcotest.(check int) "pgrp" child found.pgrp;
          check_error "no terminal" Not_found (foreground_process_group child))

let test_reaped_child_not_found () =
  let child =
    Unix.create_process "/usr/bin/true" [| "true" |] Unix.stdin Unix.stdout
      Unix.stderr
  in
  ignore (Unix.waitpid [] child);
  check_error "process" Not_found (process child);
  check_error "command_line" Not_found (command_line child);
  check_error "working_directory" Not_found (working_directory child);
  check_error "open_file_paths" Not_found (open_file_paths child);
  check_error "foreground_process_group" Not_found
    (foreground_process_group child)

let test_zombie () =
  let child =
    Unix.create_process "/usr/bin/true" [| "true" |] Unix.stdin Unix.stdout
      Unix.stderr
  in
  Fun.protect
    ~finally:(fun () -> ignore (Unix.waitpid [] child))
    (fun () ->
      let zombie =
        wait_for "zombie" (fun () ->
            match process child with
            | Ok found when found.state = 'Z' -> Some found
            | _ -> None)
      in
      Alcotest.(check int) "ppid" (Unix.getpid ()) zombie.ppid;
      Alcotest.(check int) "sid unknown" 0 zombie.sid;
      Alcotest.(check (list string))
        "no arguments" []
        (ok_or_fail "zombie argv" (command_line child));
      check_error "cwd" Not_found (working_directory child);
      Alcotest.(check bool)
        "listed by snapshot" true
        (List.exists
           (fun (p : process) -> p.pid = child)
           (ok_or_fail "snapshot" (snapshot ()))))

let test_invalid_pids () =
  List.iter
    (fun pid -> check_error (string_of_int pid) Not_found (process pid))
    [ 0; -1; max_int; 0x7fffffff ]

(* pid 1 belongs to root: visible, but its details are refused. *)
let test_pid_one () =
  let launchd = ok_or_fail "pid 1" (process 1) in
  Alcotest.(check int) "ppid" 0 launchd.ppid;
  Alcotest.(check string) "comm" "launchd" launchd.comm;
  if Unix.geteuid () <> 0 then (
    check_error "command_line" Denied (command_line 1);
    check_error "working_directory" Denied (working_directory 1);
    check_error "open_file_paths" Denied (open_file_paths 1))

let test_open_file_paths_self () =
  let opened = Unix.realpath (Filename.temp_file "mesh-platform" ".txt") in
  let descriptor = Unix.openfile opened [ Unix.O_RDONLY ] 0 in
  Fun.protect
    ~finally:(fun () ->
      Unix.close descriptor;
      Sys.remove opened)
    (fun () ->
      let targets = ok_or_fail "fds" (open_file_paths (Unix.getpid ())) in
      Alcotest.(check bool)
        "temp file listed" true
        (List.exists (fun (_, target) -> target = opened) targets);
      Alcotest.(check bool)
        "all absolute" true
        (List.for_all (fun (_, target) -> target.[0] = '/') targets);
      Alcotest.(check bool)
        "sorted by fd" true
        (List.sort compare targets = targets))

(* script(1) runs its command on a new pseudo-terminal as a session leader. *)
let test_pty_child () =
  with_child "/usr/bin/script"
    [| "script"; "-q"; "/dev/null"; "/bin/sleep"; "30" |] (fun script ->
      let leader =
        wait_for "script child" (fun () ->
            match snapshot () with
            | Ok table ->
                List.find_opt
                  (fun (p : process) -> p.ppid = script && p.comm = "sleep")
                  table
            | Error _ -> None)
      in
      let files = ok_or_fail "fds" (open_file_paths leader.pid) in
      (match List.assoc_opt 0 files with
      | Some tty ->
          Alcotest.(check bool)
            (Printf.sprintf "fd 0 %S is a /dev/ttys device" tty)
            true
            (String.starts_with ~prefix:"/dev/ttys" tty)
      | None -> Alcotest.fail "fd 0 not listed");
      Alcotest.(check int) "session leader" leader.pid leader.sid;
      Alcotest.(check int)
        "foreground group" leader.pgrp
        (ok_or_fail "foreground" (foreground_process_group leader.pid)))

let test_snapshot () =
  let table = ok_or_fail "snapshot" (snapshot ()) in
  let pids = List.map (fun (p : process) -> p.pid) table in
  Alcotest.(check bool) "self" true (List.mem (Unix.getpid ()) pids);
  Alcotest.(check bool) "pid 1" true (List.mem 1 pids);
  Alcotest.(check bool)
    "sorted, no duplicate" true
    (List.sort_uniq compare pids = pids)

let test_foreground_group_never_non_positive () =
  match foreground_process_group (Unix.getpid ()) with
  | Ok group -> Alcotest.(check bool) "positive" true (group > 0)
  | Error Not_found -> ()
  | Error e -> Alcotest.fail (error_to_string e)

let test_capabilities () =
  let caps = capabilities () in
  Alcotest.(check bool) "process_table" true caps.process_table;
  Alcotest.(check bool) "foreground_agent" true caps.foreground_agent;
  Alcotest.(check bool) "open_file_paths" true caps.open_file_paths;
  Alcotest.(check bool) "isolated_agent" false caps.isolated_agent;
  Alcotest.(check bool) "demo_sandbox" false caps.demo_sandbox

let test_socket_unsupported () =
  match unix_socket_bound "/nonexistent/socket" with
  | Error (Unsupported _) -> ()
  | Ok _ -> Alcotest.fail "expected Unsupported"
  | Error e -> Alcotest.fail (error_to_string e)

(* The default directory below the real passwd home: Application Support must
   be canonical (no firmlink or symlink shows through realpath), and the socket
   path must fit. Checked without creating anything in the real home. *)
let test_runtime_dir_default_is_canonical () =
  let home = (Unix.getpwuid (Unix.geteuid ())).Unix.pw_dir in
  let support = Filename.concat home "Library/Application Support" in
  Alcotest.(check string) "realpath" support (Unix.realpath support);
  let socket =
    Filename.concat support "session-mesh/run/session-mesh/ptyhost.sock"
  in
  Alcotest.(check bool)
    (Printf.sprintf "%S fits sun_path" socket)
    true
    (String.length socket <= max_socket_path)

let macos_tests =
  [
    Alcotest.test_case "process of self" `Quick test_process_self;
    Alcotest.test_case "command line of self" `Quick test_command_line_self;
    Alcotest.test_case "working directory of self" `Quick
      test_working_directory_self;
    Alcotest.test_case "child process" `Quick test_child;
    Alcotest.test_case "owned child environment" `Quick test_child_environment;
    Alcotest.test_case "session id of a setsid child" `Quick test_session_id;
    Alcotest.test_case "reaped child is Not_found" `Quick
      test_reaped_child_not_found;
    Alcotest.test_case "zombie child" `Quick test_zombie;
    Alcotest.test_case "invalid pids are Not_found" `Quick test_invalid_pids;
    Alcotest.test_case "pid 1" `Quick test_pid_one;
    Alcotest.test_case "open file paths of self" `Quick
      test_open_file_paths_self;
    Alcotest.test_case "pty child" `Quick test_pty_child;
    Alcotest.test_case "snapshot" `Quick test_snapshot;
    Alcotest.test_case "foreground group never non-positive" `Quick
      test_foreground_group_never_non_positive;
    Alcotest.test_case "capabilities" `Quick test_capabilities;
    Alcotest.test_case "unix_socket_bound is Unsupported" `Quick
      test_socket_unsupported;
    Alcotest.test_case "runtime dir default is canonical" `Quick
      test_runtime_dir_default_is_canonical;
  ]

let skipped () =
  print_endline "skipped: the darwin backend tests need a macOS build";
  Alcotest.skip ()

let tests =
  match platform with
  | Macos -> macos_tests
  | Linux | Other _ ->
      [ Alcotest.test_case "darwin backend (macOS only)" `Quick skipped ]
