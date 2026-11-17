(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* A black-box interop client: no Python client helpers are used below. *)

let timeout = 5.0
let failf format = Printf.ksprintf failwith format

type read_phase =
  | Startup
  | Initial_list
  | New
  | Listed
  | Attach_control
  | Attach_replay
  | Kill
  | Absent
  | Malformed

let phase_number = function
  | Startup -> 1
  | Initial_list -> 2
  | New -> 3
  | Listed -> 4
  | Attach_control -> 5
  | Attach_replay -> 6
  | Kill -> 7
  | Absent -> 8
  | Malformed -> 9

let with_read_phase phase f =
  try f ()
  with Failure message when message = "socket read timed out" ->
    let trace = Printexc.get_raw_backtrace () in
    Printexc.raise_with_backtrace
      (Failure
         (Printf.sprintf "interop read phase %d: socket read timed out"
            (phase_number phase)))
      trace

let wait_readable fd =
  let ready, _, _ = Unix.select [ fd ] [] [] timeout in
  if ready = [] then failwith "socket read timed out"

let read_startup input =
  let fd = Unix.descr_of_in_channel input in
  let chunk = Bytes.create 256 in
  let line = Buffer.create 256 in
  let rec read () =
    wait_readable fd;
    match Unix.read fd chunk 0 (Bytes.length chunk) with
    | 0 -> failwith "ptyhost harness closed before announcing its socket"
    | count -> (
        match Bytes.index_from_opt chunk 0 '\n' with
        | Some newline ->
            Buffer.add_subbytes line chunk 0 newline;
            Buffer.contents line
        | None ->
            Buffer.add_subbytes line chunk 0 count;
            read ())
  in
  read ()

let rec write_all fd bytes offset length =
  if length > 0 then begin
    let _, writable, _ = Unix.select [] [ fd ] [] timeout in
    if writable = [] then failwith "socket write timed out";
    let written = Unix.write fd bytes offset length in
    write_all fd bytes (offset + written) (length - written)
  end

let rec read_exact fd bytes offset length =
  if length > 0 then begin
    wait_readable fd;
    match Unix.read fd bytes offset length with
    | 0 -> failwith "socket closed before its reply"
    | read -> read_exact fd bytes (offset + read) (length - read)
  end

let read_frame fd =
  let header = Bytes.create 5 in
  read_exact fd header 0 5;
  let size =
    (Char.code (Bytes.get header 1) lsl 24)
    lor (Char.code (Bytes.get header 2) lsl 16)
    lor (Char.code (Bytes.get header 3) lsl 8)
    lor Char.code (Bytes.get header 4)
  in
  if size > Mesh_wire.max_small_frame then
    failwith "unexpected large control reply";
  let wire = Bytes.create (5 + size) in
  Bytes.blit header 0 wire 0 5;
  read_exact fd wire 5 size;
  match Mesh_wire.decode (Bytes.unsafe_to_string wire) with
  | Ok (frame, "") -> frame
  | Ok _ -> failwith "control reply left bytes"
  | Error _ -> failwith "Mesh_wire rejected a complete control reply"

let connect socket =
  let fd = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Unix.connect fd (Unix.ADDR_UNIX socket);
  fd

let request socket json =
  let fd = connect socket in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let wire = Mesh_wire.encode { kind = 'C'; payload = json } in
      write_all fd (Bytes.unsafe_of_string wire) 0 (String.length wire);
      let reply = read_frame fd in
      if reply.kind <> 'C' then failwith "reply was not a C frame";
      Yojson.Safe.from_string reply.payload)

let attach socket =
  let fd = connect socket in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let wire =
        Mesh_wire.encode
          {
            kind = 'C';
            payload =
              "{\"op\":\"attach\",\"name\":\"ocaml-interop\",\"rows\":24,\"cols\":80}";
          }
      in
      write_all fd (Bytes.unsafe_of_string wire) 0 (String.length wire);
      let acknowledgement =
        with_read_phase Attach_control (fun () -> read_frame fd)
      in
      if acknowledgement.kind <> 'C' then
        failwith "attach acknowledgement was not a C frame";
      (match Yojson.Safe.from_string acknowledgement.payload with
      | `Assoc _ as reply -> (
          match Yojson.Safe.Util.member "ok" reply with
          | `Bool true -> ()
          | _ -> failwith "attach was refused")
      | _ -> failwith "attach did not reply with an object");
      let replay = with_read_phase Attach_replay (fun () -> read_frame fd) in
      if replay.kind <> 'D' || replay.payload <> "" then
        failwith
          "attach did not follow its acknowledgement with the empty replay")

let member_string name json =
  match Yojson.Safe.Util.member name json with
  | `String value -> value
  | _ -> failf "reply has no string %S" name

let expect_ok expected json =
  match Yojson.Safe.Util.member "ok" json with
  | `Bool true ->
      if member_string "name" json <> expected then
        failwith "new replied with another name"
  | _ -> failwith "new request was not accepted"

let expect_empty_list json =
  match json with `List [] -> () | _ -> failwith "expected no sessions"

let expect_listed name json =
  match json with
  | `List sessions
    when List.exists
           (fun session -> member_string "name" session = name)
           sessions ->
      ()
  | _ -> failwith "new session was absent from list"

let expect_error_object json =
  match Yojson.Safe.Util.member "error" json with
  | `String _ -> ()
  | _ -> failwith "malformed C JSON did not yield a C JSON error object"

let rec wait_absent socket name remaining =
  if remaining = 0 then failwith "killed session remained listed";
  let listed = request socket "{\"op\":\"list\"}" in
  match listed with
  | `List sessions
    when List.exists
           (fun session -> member_string "name" session = name)
           sessions ->
      Unix.sleepf 0.05;
      wait_absent socket name (remaining - 1)
  | `List _ -> ()
  | _ -> failwith "list did not reply with an array"

let status_string = function
  | Unix.WEXITED code -> Printf.sprintf "exited %d" code
  | Unix.WSIGNALED signal -> Printf.sprintf "signalled %d" signal
  | Unix.WSTOPPED signal -> Printf.sprintf "stopped %d" signal

let run harness =
  let python = Option.value (Sys.getenv_opt "PYTHON") ~default:"python3" in
  let input, output, errors =
    Unix.open_process_args_full python
      [| python; harness; "--interop" |]
      (Unix.environment ())
  in
  Fun.protect
    ~finally:(fun () ->
      close_out_noerr output;
      let stderr = In_channel.input_all errors in
      match Unix.close_process_full (input, output, errors) with
      | Unix.WEXITED 0 -> ()
      | status ->
          failf "ptyhost harness cleanup %s: %s" (status_string status) stderr)
    (fun () ->
      let startup =
        Yojson.Safe.from_string
          (with_read_phase Startup (fun () -> read_startup input))
      in
      let socket = member_string "socket" startup in
      let home = member_string "home" startup in
      expect_empty_list
        (with_read_phase Initial_list (fun () ->
             request socket "{\"op\":\"list\"}"));
      expect_ok "ocaml-interop"
        (with_read_phase New (fun () ->
             request socket
               (Printf.sprintf
                  "{\"op\":\"new\",\"name\":\"ocaml-interop\",\"cwd\":%S,\"command\":\"sleep \
                   60\"}"
                  home)));
      expect_listed "ocaml-interop"
        (with_read_phase Listed (fun () -> request socket "{\"op\":\"list\"}"));
      attach socket;
      (match
         with_read_phase Kill (fun () ->
             request socket "{\"op\":\"kill\",\"name\":\"ocaml-interop\"}")
       with
      | `Assoc _ as reply -> (
          match Yojson.Safe.Util.member "ok" reply with
          | `Bool true -> ()
          | _ -> failwith "kill was refused")
      | _ -> failwith "kill did not reply with an object");
      with_read_phase Absent (fun () -> wait_absent socket "ocaml-interop" 100);
      expect_error_object
        (with_read_phase Malformed (fun () -> request socket "{")))

let diagnostic_tests () =
  if timeout <> 5.0 then failwith "read timeout contract changed";
  List.iter
    (fun (phase, expected_number) ->
      let expected =
        Printf.sprintf "interop read phase %d: socket read timed out"
          expected_number
      in
      match
        with_read_phase phase (fun () -> failwith "socket read timed out")
      with
      | () -> failwith "timeout control unexpectedly returned"
      | exception Failure actual when actual = expected -> ()
      | exception _ -> failwith "timeout control lost its fixed phase")
    [
      (Startup, 1);
      (Initial_list, 2);
      (New, 3);
      (Listed, 4);
      (Attach_control, 5);
      (Attach_replay, 6);
      (Kill, 7);
      (Absent, 8);
      (Malformed, 9);
    ];
  List.iter
    (fun original ->
      let trace = Printexc.get_callstack 10 in
      match
        with_read_phase Kill (fun () ->
            Printexc.raise_with_backtrace original trace)
      with
      | () -> failwith "exception control unexpectedly returned"
      | exception actual ->
          let actual_trace = Printexc.get_raw_backtrace () in
          if actual != original then failwith "exception identity changed";
          (* Propagation can append caller frames; the original trace must
             remain the unchanged prefix, not be reset at this helper. *)
          if
            Printexc.raw_backtrace_length actual_trace
            < Printexc.raw_backtrace_length trace
          then failwith "exception backtrace was truncated";
          for i = 0 to Printexc.raw_backtrace_length trace - 1 do
            if
              Printexc.get_raw_backtrace_slot actual_trace i
              <> Printexc.get_raw_backtrace_slot trace i
            then failwith "exception backtrace prefix changed"
          done)
    [ Failure "socket read timed out extra"; Sys.Break; Out_of_memory ];
  let reader, writer = Unix.socketpair Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Fun.protect
    ~finally:(fun () ->
      Unix.close reader;
      Unix.close writer)
    (fun () ->
      match with_read_phase Startup (fun () -> wait_readable reader) with
      | () -> failwith "real timeout control unexpectedly returned"
      | exception Failure message
        when message = "interop read phase 1: socket read timed out" ->
          ()
      | exception _ -> failwith "real timeout control lost its fixed phase");
  Printf.printf "interop diagnostics: 13 controls passed\n%!"

(* tests/ptyhost_proc.py imports pytest. Off Linux, where the Python harness
   is optional, a missing pytest skips the run with the reason; on Linux it
   fails, as any other harness failure does. *)
let python_has_pytest () =
  let python = Option.value (Sys.getenv_opt "PYTHON") ~default:"python3" in
  Sys.command
    (Filename.quote_command python [ "-c"; "import pytest" ] ~stdout:"/dev/null"
       ~stderr:"/dev/null")
  = 0

let normal_interop () =
  if Mesh_platform.platform <> Mesh_platform.Linux && not (python_has_pytest ())
  then (
    print_endline
      "interop skipped: the Python harness needs pytest, which $PYTHON \
       (default python3) cannot import";
    exit 0);
  let source_root =
    match Sys.getenv_opt "DUNE_SOURCEROOT" with
    | Some root -> root
    | None -> failwith "Dune did not provide its source root"
  in
  run (Filename.concat (Filename.dirname source_root) "tests/ptyhost_proc.py")

let () =
  match Array.to_list Sys.argv with
  | [ _ ] -> normal_interop ()
  | [ _; "--diagnostic-test" ] -> (
      Printexc.record_backtrace true;
      try diagnostic_tests ()
      with Failure _ ->
        Printf.eprintf "interop diagnostics: control failed\n%!";
        exit 1)
  | _ -> failwith "usage: ptyhost_interop [--diagnostic-test]"
