(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Error-handling decisions: EINTR retry, quiet close, snapshot skipping, and
   the no-terminal foreground group. All pure or self-contained. *)

open Mesh_platform

let process_with pid : process =
  {
    pid;
    ppid = 1;
    pgrp = pid;
    sid = pid;
    tpgid = -1;
    comm = "x";
    state = 'S';
    incarnation = 1L;
  }

let test_retry_on_eintr () =
  let calls = ref 0 in
  let value =
    Support.retry_on_eintr (fun () ->
        incr calls;
        if !calls < 3 then raise (Unix.Unix_error (Unix.EINTR, "read", ""))
        else "done")
  in
  Alcotest.(check string) "result" "done" value;
  Alcotest.(check int) "attempts" 3 !calls

let test_retry_passes_other_errors () =
  match
    Support.retry_on_eintr (fun () ->
        raise (Unix.Unix_error (Unix.EBADF, "read", "")))
  with
  | _ -> Alcotest.fail "expected EBADF"
  | exception Unix.Unix_error (Unix.EBADF, _, _) -> ()

let test_close_errors_ignored () =
  let read_end, write_end = Unix.pipe () in
  Unix.close read_end;
  Unix.close write_end;
  (* Both descriptors are already closed: Unix.close raises EBADF. *)
  Support.close_quietly read_end;
  let handle = Unix.opendir "/" in
  Unix.closedir handle;
  Support.closedir_quietly handle;
  (* Inside Fun.protect, a raising [finally] would escape as Finally_raised. *)
  let result =
    Fun.protect
      ~finally:(fun () -> Support.close_quietly write_end)
      (fun () -> Ok 1)
  in
  Alcotest.(check (result int string)) "unchanged" (Ok 1) result

let read_with_failures = function
  | 10 -> Ok (process_with 10)
  | 20 -> Error (Malformed "garbage")
  | 30 -> Error Not_found
  | 40 -> Error Denied
  | pid -> Ok (process_with pid)

let test_collect_skips_unreadable () =
  match
    Support.collect_processes
      [ "40"; "30"; "self"; "20"; "10"; "5" ]
      read_with_failures
  with
  | Ok found ->
      Alcotest.(check (list int))
        "pids" [ 5; 10 ]
        (List.map (fun (p : process) -> p.pid) found)
  | Error e -> Alcotest.fail (error_to_string e)

let test_collect_counts_skipped () =
  match
    Support.collect_scan [ "40"; "30"; "20"; "10"; "5" ] read_with_failures
  with
  | Ok { processes; skipped } ->
      Alcotest.(check (list int))
        "pids" [ 5; 10 ]
        (List.map (fun (p : process) -> p.pid) processes);
      Alcotest.(check int) "denied and malformed counted, exited not" 2 skipped
  | Error e -> Alcotest.fail (error_to_string e)

let test_collect_fails_on_unsupported () =
  match
    Support.collect_processes [ "1" ] (fun _ -> Error (Unsupported "no"))
  with
  | Error (Unsupported _) -> ()
  | _ -> Alcotest.fail "expected Unsupported"

let test_foreground_group () =
  Alcotest.(check bool) "positive" true (Parse.foreground_group 77 = Ok 77);
  Alcotest.(check bool)
    "minus one" true
    (Parse.foreground_group (-1) = Error Not_found);
  Alcotest.(check bool) "zero" true (Parse.foreground_group 0 = Error Not_found)

let test_socket_table_parse () =
  let table =
    "Num RefCount Protocol Flags Type St Inode Path\n\
     0000: 00000002 00000000 00010000 0001 01 1 /run/a.sock\n\
     0001: 00000002 00000000 00010000 0001 01 2 @abstract\n\
     0002: 00000003 00000000 00000000 0001 03 3\n"
  in
  let bound = Parse.linux_unix_socket_bound table in
  Alcotest.(check bool) "listed path" true (bound "/run/a.sock");
  Alcotest.(check bool) "longer path is not a match" false (bound "/a.sock");
  Alcotest.(check bool) "absent path" false (bound "/run/b.sock");
  Alcotest.(check bool)
    "empty table" false
    (Parse.linux_unix_socket_bound "" "/run/a.sock")

(* The kernel pads the inode on the left; a path can hold spaces; a socket
   bound at the relative path "x /run/a.sock" ends its line with " /run/a.sock"
   but is not bound at /run/a.sock. *)
let test_socket_table_path_field () =
  let table =
    "Num       RefCount Protocol Flags    Type St Inode Path\n\
     0000000000000000: 00000002 00000000 00010000 0001 01     7 x /run/a.sock\n\
     0000000000000000: 00000002 00000000 00010000 0001 01 12345 /run/b c.sock\n"
  in
  let bound = Parse.linux_unix_socket_bound table in
  Alcotest.(check bool)
    "relative path forges no match" false (bound "/run/a.sock");
  Alcotest.(check bool) "the relative path itself" true (bound "x /run/a.sock");
  Alcotest.(check bool) "path with a space" true (bound "/run/b c.sock");
  Alcotest.(check bool) "suffix of a path with a space" false (bound "c.sock");
  Alcotest.(check bool) "header is not a socket" false (bound "Path")

let test_socket_unsupported () =
  match For_testing.unsupported_unix_socket_bound "/run/a.sock" with
  | Error (Unsupported _) -> ()
  | Ok _ -> Alcotest.fail "unsupported backend answered"
  | Error e -> Alcotest.fail (error_to_string e)

let tests =
  [
    Alcotest.test_case "retry on EINTR" `Quick test_retry_on_eintr;
    Alcotest.test_case "retry keeps other errors" `Quick
      test_retry_passes_other_errors;
    Alcotest.test_case "close errors ignored" `Quick test_close_errors_ignored;
    Alcotest.test_case "snapshot skips unreadable processes" `Quick
      test_collect_skips_unreadable;
    Alcotest.test_case "scan counts skipped processes" `Quick
      test_collect_counts_skipped;
    Alcotest.test_case "snapshot fails on other errors" `Quick
      test_collect_fails_on_unsupported;
    Alcotest.test_case "foreground group without terminal" `Quick
      test_foreground_group;
    Alcotest.test_case "socket table parsing" `Quick test_socket_table_parse;
    Alcotest.test_case "socket table path field" `Quick
      test_socket_table_path_field;
    Alcotest.test_case "unsupported backend refuses socket inspection" `Quick
      test_socket_unsupported;
  ]
