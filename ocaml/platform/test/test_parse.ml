(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Mesh_platform

let error_testable =
  Alcotest.testable
    (fun fmt e -> Format.pp_print_string fmt (error_to_string e))
    ( = )

let is_malformed = function Error (Malformed _) -> true | _ -> false

let check_malformed name result =
  Alcotest.(check bool) name true (is_malformed result)

(* Fields after the comm, starting with the state: index 0 is the state, index
   19 is starttime. Indices 6..18 are filler. *)
let stat_fields ~starttime =
  [ "S"; "100"; "200"; "300"; "34816"; "400" ]
  @ List.init 13 (fun i -> string_of_int (i + 6))
  @ [ starttime; "12345"; "678" ]

let stat_line ~pid ~comm ~starttime =
  Printf.sprintf "%d (%s) %s\n" pid comm
    (String.concat " " (stat_fields ~starttime))

let test_stat_plain () =
  match
    Parse.linux_stat (stat_line ~pid:42 ~comm:"bash" ~starttime:"987654321")
  with
  | Ok p ->
      Alcotest.(check int) "pid" 42 p.pid;
      Alcotest.(check string) "comm" "bash" p.comm;
      Alcotest.(check char) "state" 'S' p.state;
      Alcotest.(check int) "ppid" 100 p.ppid;
      Alcotest.(check int) "pgrp" 200 p.pgrp;
      Alcotest.(check int) "sid" 300 p.sid;
      Alcotest.(check int) "tpgid" 400 p.tpgid;
      Alcotest.(check int64) "incarnation" 987654321L p.incarnation
  | Error e -> Alcotest.fail (error_to_string e)

let test_stat_tricky_comm () =
  let comm = "a b) (c d)" in
  match Parse.linux_stat (stat_line ~pid:7 ~comm ~starttime:"55") with
  | Ok p ->
      Alcotest.(check string) "comm" comm p.comm;
      Alcotest.(check int) "ppid" 100 p.ppid;
      Alcotest.(check int64) "incarnation" 55L p.incarnation
  | Error e -> Alcotest.fail (error_to_string e)

let test_stat_malformed () =
  check_malformed "empty" (Parse.linux_stat "");
  check_malformed "no parentheses" (Parse.linux_stat "1 bash S 1 2 3");
  check_malformed "reversed parentheses" (Parse.linux_stat "1 )bash( S");
  check_malformed "too few fields" (Parse.linux_stat "1 (bash) S 1 2 3");
  check_malformed "non-numeric pid"
    (Parse.linux_stat
       ( stat_line ~pid:1 ~comm:"x" ~starttime:"5" |> fun s ->
         "abc" ^ String.sub s 1 (String.length s - 1) ));
  check_malformed "non-numeric starttime"
    (Parse.linux_stat (stat_line ~pid:1 ~comm:"x" ~starttime:"soon"))

let test_cmdline () =
  let check name expected input =
    Alcotest.(check (list string)) name expected (Parse.linux_cmdline input)
  in
  check "empty" [] "";
  check "one argument" [ "ls" ] "ls\000";
  check "two arguments" [ "ls"; "-l" ] "ls\000-l\000";
  check "no trailing NUL" [ "ls"; "-l" ] "ls\000-l";
  check "empty argument kept" [ "echo"; "" ] "echo\000\000"

(* The [procargs2] fixtures built below are synthesized by hand from the
   documented KERN_PROCARGS2 layout, not recorded from a Mac; the one recorded
   on a Mac is [recorded_procargs2], further down. *)
let procargs2 ~argc ~exec_path ~padding ~argv () =
  let buffer = Buffer.create 64 in
  let header = Bytes.create 4 in
  Bytes.set_int32_le header 0 (Int32.of_int argc);
  Buffer.add_bytes buffer header;
  Buffer.add_string buffer exec_path;
  Buffer.add_char buffer '\000';
  Buffer.add_string buffer (String.make padding '\000');
  List.iter
    (fun arg ->
      Buffer.add_string buffer arg;
      Buffer.add_char buffer '\000')
    argv;
  Buffer.add_string buffer "TERM=xterm\000";
  Buffer.contents buffer

let test_procargs_valid () =
  let buffer =
    procargs2 ~argc:3 ~exec_path:"/usr/bin/ssh" ~padding:5
      ~argv:[ "ssh"; "-v"; "host" ] ()
  in
  Alcotest.(check (result (list string) error_testable))
    "argv"
    (Ok [ "ssh"; "-v"; "host" ])
    (Parse.darwin_procargs2 buffer)

let test_procargs_no_padding () =
  let buffer =
    procargs2 ~argc:1 ~exec_path:"/bin/ls" ~padding:0 ~argv:[ "ls" ] ()
  in
  Alcotest.(check (result (list string) error_testable))
    "argv" (Ok [ "ls" ])
    (Parse.darwin_procargs2 buffer)

let test_procargs_argc_zero () =
  let buffer = procargs2 ~argc:0 ~exec_path:"/bin/ls" ~padding:3 ~argv:[] () in
  Alcotest.(check (result (list string) error_testable))
    "empty" (Ok [])
    (Parse.darwin_procargs2 buffer)

let test_procargs_truncated () =
  (* argc says 3 but only two argv strings follow the padding; the
     environment string is not an argv string, so build without it. *)
  let header = Bytes.create 4 in
  Bytes.set_int32_le header 0 3l;
  let truncated = Bytes.to_string header ^ "/bin/x\000\000a\000b\000" in
  check_malformed "missing argv" (Parse.darwin_procargs2 truncated);
  let unterminated = Bytes.to_string header ^ "/bin/x\000\000a\000b\000c" in
  check_malformed "unterminated argv" (Parse.darwin_procargs2 unterminated);
  let no_exec_end = Bytes.to_string header ^ "/bin/x" in
  check_malformed "unterminated exec path" (Parse.darwin_procargs2 no_exec_end)

let test_procargs_bad_argc () =
  check_malformed "negative argc"
    (Parse.darwin_procargs2
       (procargs2 ~argc:(-1) ~exec_path:"/bin/x" ~padding:0 ~argv:[] ()));
  check_malformed "absurd argc"
    (Parse.darwin_procargs2
       (procargs2 ~argc:65537 ~exec_path:"/bin/x" ~padding:0 ~argv:[] ()));
  check_malformed "empty buffer" (Parse.darwin_procargs2 "");
  check_malformed "short buffer" (Parse.darwin_procargs2 "\001\000\000")

(* Recorded with sysctl(KERN_PROCARGS2) on macOS 15.6 (arm64) from
   [env -i PATH=/usr/bin:/bin LANG=C /bin/sh -c 'read x' sh "two words" "" last]
   run in /. Neutral content only. /bin/sh is bash there, hence the exec path;
   the kernel returned no environment strings for this process. *)
let recorded_procargs2 =
  "\007\000\000\000/bin/bash\000\000\000\000\000\000\000/bin/sh\000-c\000read \
   x\000sh\000two words\000\000last\000"

let test_procargs_recorded () =
  Alcotest.(check (result (list string) error_testable))
    "argv"
    (Ok [ "/bin/sh"; "-c"; "read x"; "sh"; "two words"; ""; "last" ])
    (Parse.darwin_procargs2 recorded_procargs2)

let test_darwin_state () =
  let check status expected =
    Alcotest.(check (option char))
      (string_of_int status) expected
      (Parse.darwin_state status)
  in
  check 1 (Some 'R');
  check 2 (Some 'R');
  check 3 (Some 'S');
  check 4 (Some 'T');
  check 5 (Some 'Z');
  check 0 None;
  check 6 None;
  check (-1) None

let tests =
  [
    Alcotest.test_case "procargs2 recorded on macOS" `Quick
      test_procargs_recorded;
    Alcotest.test_case "darwin_state" `Quick test_darwin_state;
    Alcotest.test_case "linux_stat plain" `Quick test_stat_plain;
    Alcotest.test_case "linux_stat comm with spaces and parentheses" `Quick
      test_stat_tricky_comm;
    Alcotest.test_case "linux_stat malformed" `Quick test_stat_malformed;
    Alcotest.test_case "linux_cmdline" `Quick test_cmdline;
    Alcotest.test_case "procargs2 valid with padding" `Quick test_procargs_valid;
    Alcotest.test_case "procargs2 no padding" `Quick test_procargs_no_padding;
    Alcotest.test_case "procargs2 argc 0" `Quick test_procargs_argc_zero;
    Alcotest.test_case "procargs2 truncated" `Quick test_procargs_truncated;
    Alcotest.test_case "procargs2 bad argc and short buffer" `Quick
      test_procargs_bad_argc;
  ]
