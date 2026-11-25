(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The [processes] operation: its rules on fake process facts, then the built
   host, given as the first argument, over its socket. *)

open Ptyhost_blackbox
module P = Mesh_platform
module Facts = Mesh_pty_processes
module U = Yojson.Basic.Util

let proc ?(tpgid = -1) ?(comm = "daemon") ~pid ~sid () =
  {
    P.pid;
    ppid = 1;
    pgrp = pid;
    sid;
    tpgid;
    comm;
    state = 'S';
    incarnation = 7L;
  }

(* Facts where every per-process read of [failing] fails. *)
let fake ?(failing = []) ?(skipped = 0) ?(snapshot = Ok []) () =
  let read pid value =
    if List.mem pid failing then Error P.Denied else Ok value
  in
  {
    Facts.scan =
      (fun () ->
        Result.map (fun processes -> { P.processes; skipped }) snapshot);
    process =
      (fun pid ->
        match snapshot with
        | Ok processes -> (
            match
              List.find_opt (fun (p : P.process) -> p.pid = pid) processes
            with
            | Some p -> Ok p
            | None -> Error P.Not_found)
        | Error e -> Error e);
    command_line =
      (fun pid ->
        read pid (if pid = 30 then [ "/opt/bin/codex"; "--x" ] else [ "sh" ]));
    working_directory = (fun pid -> read pid "/work");
    open_file_paths =
      (fun pid ->
        read pid [ (0, "/dev/ttys001"); (9, "/h/.codex/sessions/r.jsonl") ]);
    process_owner = (fun pid -> read pid 1000);
  }

let table ?budget facts =
  Facts.reply ~platform:facts ?budget
    (Facts.parse [ ("op", `String "processes") ])

let rows reply = U.to_list (U.member "processes" reply)

let row reply pid =
  List.find (fun r -> U.member "pid" r = `Int pid) (rows reply)

let keys json = List.map fst (U.to_assoc json)
let leader = proc ~pid:10 ~sid:10 ~tpgid:10 ()
let daemon = proc ~pid:20 ~sid:20 ()
let codex = proc ~pid:30 ~sid:10 ~tpgid:10 ~comm:"node" ()

let details_follow_the_rules () =
  let reply = table (fake ~snapshot:(Ok [ leader; daemon; codex ]) ()) in
  Alcotest.(check bool) "complete" true (U.member "complete" reply = `Bool true);
  Alcotest.(check (list string))
    "leader" [ "argv"; "cwd"; "stdin" ]
    (List.filteri (fun i _ -> i >= 8) (keys (row reply 10)));
  Alcotest.(check string)
    "stdin" "/dev/ttys001"
    (U.to_string (U.member "stdin" (row reply 10)));
  Alcotest.(check int)
    "no details without a terminal" 8
    (List.length (keys (row reply 20)));
  Alcotest.(check bool)
    "no stdin outside a session leader" true
    (not (List.mem "stdin" (keys (row reply 30))));
  Alcotest.(check (list string))
    "codex by argv[0]: its open files"
    [ "/dev/ttys001"; "/h/.codex/sessions/r.jsonl" ]
    (List.map U.to_string (U.to_list (U.member "open_files" (row reply 30))))

let an_unreadable_detail_is_null () =
  let reply =
    table (fake ~failing:[ 10 ] ~snapshot:(Ok [ leader; codex ]) ())
  in
  List.iter
    (fun key ->
      Alcotest.(check bool) key true (U.member key (row reply 10) = `Null))
    [ "argv"; "cwd"; "stdin" ];
  Alcotest.(check bool)
    "others intact" true
    (U.member "cwd" (row reply 30) = `String "/work")

let an_unreadable_table_is_empty () =
  let reply = table (fake ~snapshot:(Error (P.Unsupported "no")) ()) in
  Alcotest.(check bool)
    "incomplete" true
    (U.member "complete" reply = `Bool false);
  Alcotest.(check int) "empty" 0 (List.length (rows reply))

let pids reply = List.map (fun r -> U.to_int (U.member "pid" r)) (rows reply)
let row_size json = String.length (Yojson.Basic.to_string json) + 1
let bare json = `Assoc (List.filteri (fun i _ -> i < 8) (U.to_assoc json))
let has_details json = List.length (keys json) > 8

let within_budget budget reply =
  Alcotest.(check bool)
    "within the budget" true
    (List.fold_left (fun sum r -> sum + row_size r) 0 (rows reply) <= budget)

(* A process with a terminal that is neither its session leader nor in the
   foreground group: lowest priority for details among those that have some. *)
let background = proc ~pid:15 ~sid:10 ~tpgid:10 ~comm:"sh" ()

let bare_rows_first_then_details_by_priority () =
  let facts = fake ~snapshot:(Ok [ leader; background; daemon; codex ]) () in
  let full = table facts in
  let bare_total =
    List.fold_left (fun sum r -> sum + row_size (bare r)) 0 (rows full)
  in
  let detail pid = row_size (row full pid) - row_size (bare (row full pid)) in
  let budget = bare_total + detail 10 + detail 30 in
  let reply = table ~budget facts in
  within_budget budget reply;
  Alcotest.(check (list int))
    "every row, pid order" [ 10; 15; 20; 30 ] (pids reply);
  expect "leader details" (has_details (row reply 10));
  expect "agent details" (has_details (row reply 30));
  expect "background without details" (not (has_details (row reply 15)));
  Alcotest.(check bool)
    "incomplete" true
    (U.member "complete" reply = `Bool false)

(* Two hundred daemons with lower pids than the session and the agent. *)
let a_table_over_the_budget_keeps_what_matters () =
  let daemons =
    List.init 200 (fun i -> proc ~pid:(i + 100) ~sid:(i + 100) ())
  in
  let session = proc ~pid:5000 ~sid:5000 ~tpgid:5000 ()
  and agent = proc ~pid:5001 ~sid:5001 ~comm:"claude" () in
  let facts = fake ~snapshot:(Ok (daemons @ [ session; agent ])) () in
  let budget = 50 * row_size (bare (row (table facts) 100)) in
  let reply = table ~budget facts in
  within_budget budget reply;
  let kept = pids reply in
  expect "session kept" (List.mem 5000 kept);
  expect "agent kept" (List.mem 5001 kept);
  expect "rows dropped" (List.length kept < 202);
  Alcotest.(check (list int)) "pid order" (List.sort compare kept) kept;
  Alcotest.(check bool)
    "incomplete" true
    (U.member "complete" reply = `Bool false);
  Alcotest.(check bool)
    "bounded by default" true
    (String.length (Yojson.Basic.to_string (table facts))
    < Mesh_wire.max_small_frame)

let a_skipped_process_makes_the_table_incomplete () =
  let reply = table (fake ~skipped:1 ~snapshot:(Ok [ leader; daemon ]) ()) in
  Alcotest.(check (list int)) "rows" [ 10; 20 ] (pids reply);
  Alcotest.(check bool)
    "incomplete" true
    (U.member "complete" reply = `Bool false)

let selected_pids_report_errors () =
  let facts = fake ~snapshot:(Ok [ leader ]) () in
  let reply =
    Facts.reply ~platform:facts
      (Facts.parse
         [ ("op", `String "processes"); ("pids", `List [ `Int 10; `Int 99 ]) ])
  in
  Alcotest.(check int) "no details" 8 (List.length (keys (row reply 10)));
  Alcotest.(check string)
    "errors" {|[{"pid":99,"kind":"not_found"}]|}
    (Yojson.Basic.to_string (U.member "errors" reply))

let invalid_requests_are_refused () =
  List.iter
    (fun fields ->
      match Facts.parse fields with
      | _ ->
          Alcotest.failf "accepted %s" (Yojson.Basic.to_string (`Assoc fields))
      | exception Invalid_argument _ -> ())
    [
      [ ("op", `String "processes"); ("extra", `Int 1) ];
      [ ("op", `String "processes"); ("op", `String "processes") ];
      [ ("op", `String "processes"); ("pids", `Int 1) ];
      [ ("op", `String "processes"); ("pids", `List [ `Int 0 ]) ];
      [ ("op", `String "processes"); ("pids", `List [ `String "1" ]) ];
      [
        ("op", `String "processes");
        ("pids", `List (List.init 65 (fun i -> `Int (i + 1))));
      ];
    ]

(* The built host. *)

let host_argv = ref [||]
let program =
  "#!/bin/sh\n/bin/sh -c 'printf \"%s\\n\" \"$$\" > \"$HOME/child.pid\"; exec /bin/sleep 613'\n:\n"

let with_host f =
  let scratch =
    Filename.temp_dir
      ~temp_dir:(Test_scratch.short_temp_root ())
      "pty-processes-" ""
  in
  let home = Filename.concat scratch "home"
  and runtime = Filename.concat scratch "run" in
  let shell = Filename.concat scratch "program.sh" in
  let socket_path = Filename.concat runtime "session-mesh/ptyhost.sock" in
  Unix.mkdir home 0o700;
  Unix.mkdir runtime 0o700;
  write_shell shell program;
  let pid = start_host !host_argv ~home ~runtime ~shell in
  let session = ref None in
  Fun.protect
    ~finally:(fun () ->
      Option.iter
        (fun s -> try Unix.kill (-s) Sys.sigkill with Unix.Unix_error _ -> ())
        !session;
      stop_host pid;
      remove_tree scratch)
    (fun () ->
      wait_answering socket_path;
      f ~host:pid ~home ~socket_path session)

let processes socket_path payload = request socket_path payload

let new_session socket_path home session =
  let reply =
    request socket_path
      (Yojson.Basic.to_string
         (`Assoc
            [
              ("op", `String "new"); ("name", `String "s"); ("cwd", `String home);
            ]))
  in
  expect "created" (U.member "ok" reply = `Bool true);
  match request socket_path {|{"op":"list"}|} with
  | `List [ s ] ->
      let pid = U.to_int (U.member "pid" s) in
      session := Some pid;
      pid
  | _ -> failwith "list"

let host_serves_its_table () =
  with_host (fun ~host ~home ~socket_path session ->
      let shell = new_session socket_path home session in
      let receipt = Filename.concat home "child.pid" in
      let child_pid = ref None in
      let observed_child () =
        try
          let channel = open_in receipt in
          let line =
            Fun.protect ~finally:(fun () -> close_in channel) (fun () -> input_line channel)
          in
          match int_of_string_opt line with
          | Some pid when pid > 0 -> (
              match P.command_line pid with
              | Ok [ "/bin/sleep"; "613" ] -> child_pid := Some pid; true
              | _ -> false)
          | _ -> false
        with Sys_error _ | End_of_file -> false
      in
      ignore (wait_until "foreground child" 10. observed_child);
      let reply = processes socket_path {|{"op":"processes"}|} in
      Alcotest.(check int) "version" 1 (U.to_int (U.member "version" reply));
      Alcotest.(check int)
        "host pid" host
        (U.to_int (U.member "pid" (U.member "host" reply)));
      expect "host incarnation"
        (String.for_all
           (function '0' .. '9' -> true | _ -> false)
           (U.to_string (U.member "incarnation" (U.member "host" reply))));
      expect "complete is a boolean"
        (match U.member "complete" reply with `Bool _ -> true | _ -> false);
      (* The global scan is explicitly bounded and may be incomplete on a busy
         machine. Its completeness rules are exercised with deterministic fake
         scans above; validate our own live processes using the targeted API. *)
      let child_pid = Option.get !child_pid in
      let selected =
        processes socket_path
          (Printf.sprintf {|{"op":"processes","pids":[%d,%d]}|} shell child_pid)
      in
      Alcotest.(check (list int)) "requested live pids" [ shell; child_pid ]
        (pids selected);
      Alcotest.(check string) "no selection errors" "[]"
        (Yojson.Basic.to_string (U.member "errors" selected));
      let leader = row selected shell in
      Alcotest.(check int) "leader sid" shell (U.to_int (U.member "sid" leader));
      Alcotest.(check int)
        "leader ppid" host
        (U.to_int (U.member "ppid" leader));
      let child = row selected child_pid in
      Alcotest.(check int) "child ppid" shell (U.to_int (U.member "ppid" child));
      Alcotest.(check int) "child sid" shell (U.to_int (U.member "sid" child));
      if U.member "complete" reply = `Bool true then (
        let leader = row reply shell and child = row reply child_pid in
        Alcotest.(check string)
          "leader cwd" home
          (U.to_string (U.member "cwd" leader));
        expect "leader terminal"
          (String.starts_with ~prefix:"/dev/"
             (U.to_string (U.member "stdin" leader)));
        Alcotest.(check (list string))
          "child argv" [ "/bin/sleep"; "613" ]
          (List.map U.to_string (U.to_list (U.member "argv" child)))))

let host_serves_selected_pids () =
  with_host (fun ~host ~home ~socket_path session ->
      let shell = new_session socket_path home session in
      let reply =
        processes socket_path
          (Printf.sprintf {|{"op":"processes","pids":[%d,2147483646]}|} shell)
      in
      Alcotest.(check (list int))
        "found" [ shell ]
        (List.map (fun r -> U.to_int (U.member "pid" r)) (rows reply));
      Alcotest.(check string)
        "missing" {|[{"pid":2147483646,"kind":"not_found"}]|}
        (Yojson.Basic.to_string (U.member "errors" reply));
      let identity = processes socket_path {|{"op":"processes","pids":[]}|} in
      Alcotest.(check int)
        "identity only" host
        (U.to_int (U.member "pid" (U.member "host" identity)));
      Alcotest.(check int) "no rows" 0 (List.length (rows identity)))

let host_refuses_invalid_requests () =
  with_host (fun ~host:_ ~home:_ ~socket_path _ ->
      List.iter
        (fun payload ->
          Alcotest.(check string)
            payload {|{"error":"invalid request"}|}
            (Yojson.Basic.to_string (processes socket_path payload)))
        [
          {|{"op":"processes","name":"s"}|};
          {|{"op":"processes","op":"processes"}|};
          {|{"op":"processes","pids":[0]}|};
          {|{"op":"processes","pids":"1"}|};
        ];
      expect "still serving" (answering socket_path))

let () =
  let argv = Sys.argv in
  if Array.length argv < 2 then
    invalid_arg "usage: ptyhost_processes_test HOST [alcotest options]";
  host_argv := [| argv.(1) |];
  Alcotest.run
    ~argv:
      (Array.append [| argv.(0) |] (Array.sub argv 2 (Array.length argv - 2)))
    "PTY host processes"
    [
      ( "rules",
        [
          Alcotest.test_case "details follow the rules" `Quick
            details_follow_the_rules;
          Alcotest.test_case "an unreadable detail is null" `Quick
            an_unreadable_detail_is_null;
          Alcotest.test_case "an unreadable table is empty" `Quick
            an_unreadable_table_is_empty;
          Alcotest.test_case "bare rows first, then details by priority" `Quick
            bare_rows_first_then_details_by_priority;
          Alcotest.test_case "a table over the budget keeps what matters" `Quick
            a_table_over_the_budget_keeps_what_matters;
          Alcotest.test_case "a skipped process makes the table incomplete"
            `Quick a_skipped_process_makes_the_table_incomplete;
          Alcotest.test_case "selected pids report errors" `Quick
            selected_pids_report_errors;
          Alcotest.test_case "invalid requests are refused" `Quick
            invalid_requests_are_refused;
        ] );
      ( "host",
        [
          Alcotest.test_case "the host serves its table" `Quick
            host_serves_its_table;
          Alcotest.test_case "the host serves selected pids" `Quick
            host_serves_selected_pids;
          Alcotest.test_case "the host refuses invalid requests" `Quick
            host_refuses_invalid_requests;
        ] );
    ]
