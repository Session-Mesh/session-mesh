(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* A bounded synthetic replay slice of the PTY host lifecycle.

   The Node gate typechecks the checked-in Quint source and regenerates the
   normalised ITF before this test replays it.  This driver owns a fresh native
   ptyhost (the executable named by MESH_PTYHOST_CMD, else mesh-ptyhost on
   PATH) through the same private subprocess harness as the existing interop
   test, speaks frames only through Mesh_wire, and projects only bounded
   classes. It never replays a captured session, command, token, name, path,
   PID, or absolute timestamp. *)

open Ocaml_quint_connect

let timeout = 5.0
let fixture = "ptyhost_lifecycle.itf.json"
let spec = "ptyhost_lifecycle.qnt"
let session_name = "t44-itf"
let failf format = Printf.ksprintf failwith format

let wait_readable fd =
  let readable, _, _ = Unix.select [ fd ] [] [] timeout in
  if readable = [] then failwith "ptyhost socket read timed out"

let rec write_all fd bytes offset length =
  if length > 0 then begin
    let _, writable, _ = Unix.select [] [ fd ] [] timeout in
    if writable = [] then failwith "ptyhost socket write timed out";
    let written = Unix.write fd bytes offset length in
    write_all fd bytes (offset + written) (length - written)
  end

let rec read_exact fd bytes offset length =
  if length > 0 then begin
    wait_readable fd;
    match Unix.read fd bytes offset length with
    | 0 -> failwith "ptyhost socket closed before its reply"
    | count -> read_exact fd bytes (offset + count) (length - count)
  end

let read_frame fd =
  let header = Bytes.create 5 in
  read_exact fd header 0 5;
  let kind = Bytes.get header 0 in
  let size =
    (Char.code (Bytes.get header 1) lsl 24)
    lor (Char.code (Bytes.get header 2) lsl 16)
    lor (Char.code (Bytes.get header 3) lsl 8)
    lor Char.code (Bytes.get header 4)
  in
  let maximum =
    if Char.equal kind 'D' then Mesh_wire.max_data_frame
    else Mesh_wire.max_small_frame
  in
  if size > maximum then failf "ptyhost sent an over-large %C frame" kind;
  let wire = Bytes.create (5 + size) in
  Bytes.blit header 0 wire 0 5;
  read_exact fd wire 5 size;
  match Mesh_wire.decode (Bytes.unsafe_to_string wire) with
  | Ok (frame, "") -> frame
  | Ok _ -> failwith "ptyhost frame left trailing bytes"
  | Error _ -> failwith "Mesh_wire rejected a complete ptyhost frame"

let write_frame fd kind payload =
  let wire = Mesh_wire.encode { kind; payload } in
  write_all fd (Bytes.unsafe_of_string wire) 0 (String.length wire)

let contains text needle =
  let text_length = String.length text
  and needle_length = String.length needle in
  let rec scan index =
    if index + needle_length > text_length then false
    else if String.sub text index needle_length = needle then true
    else scan (index + 1)
  in
  scan 0

let rec wait_for_output fd marker remaining suffix =
  if remaining = 0 then failwith "synthetic terminal output was not observed";
  match read_frame fd with
  | { Mesh_wire.kind = 'D'; payload } ->
      let tail = suffix ^ payload in
      if contains tail marker then ()
      else
        let keep = min (String.length marker - 1) (String.length tail) in
        wait_for_output fd marker (remaining - 1)
          (String.sub tail (String.length tail - keep) keep)
  | frame -> failf "expected terminal D, received %C" frame.kind

let send_and_observe fd command marker =
  write_frame fd 'D' command;
  wait_for_output fd marker 64 ""

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

let json_string value = Yojson.Safe.to_string (`String value)

let member_string field = function
  | `Assoc fields -> (
      match List.assoc_opt field fields with
      | Some (`String value) -> value
      | _ -> failf "startup has no string field %S" field)
  | _ -> failwith "startup is not a JSON object"

let reply_ok = function
  | `Assoc fields -> List.assoc_opt "ok" fields = Some (`Bool true)
  | _ -> false

let source_root () =
  match Sys.getenv_opt "DUNE_SOURCEROOT" with
  | Some root -> Filename.dirname root
  | None -> failwith "Dune did not provide its source root"

let harness_path () = Filename.concat (source_root ()) "tests/ptyhost_proc.py"

(* The harness picks the host from the environment (MESH_PTYHOST_CMD, the
   absolute path of the executable, else mesh-ptyhost on PATH); the variable
   stays as it is. *)
let clean_environment () =
  Unix.environment () |> Array.to_list
  |> List.filter (fun value ->
      not (String.starts_with ~prefix:"MESH_PTY_OBSERVE_BASENAME=" value))
  |> Array.of_list

type observation = {
  mutable operation : string;
  mutable order_index : int;
  mutable result_class : string;
  mutable live : bool;
  mutable attached : bool;
  mutable replay_seen : bool;
  mutable reused : bool;
  mutable attachment_mode : string;
  mutable io_class : string;
  mutable queue_class : string;
  mutable size_class : string;
  mutable client_count : int;
  mutable fanout_class : string;
  mutable incarnation : int;
}

let initial_observation () =
  {
    operation = "initial";
    order_index = 0;
    result_class = "empty_list";
    live = false;
    attached = false;
    replay_seen = false;
    reused = false;
    attachment_mode = "none";
    io_class = "none";
    queue_class = "none";
    size_class = "none";
    client_count = 0;
    fanout_class = "none";
    incarnation = 0;
  }

(* Only these values may advance the public projection. The real adapter
   creates them after checking the corresponding wire frames or private log. *)
type verified_event =
  | Empty_control_list
  | Named_create_ack
  | Attach_ack_then_replay
  | Terminal_output_seen
  | Drop_report_seen
  | Exact_input_recovered
  | Kill_ack_then_exit
  | Geometry_observed of string
  | Second_attach_replay_seen
  | Fanout_seen_by_both
  | Second_detached
  | Surviving_output_seen

let record_event state event =
  state.order_index <-
    (if event = Empty_control_list then 0 else state.order_index + 1);
  begin match event with
  | Empty_control_list ->
      state.operation <- "initial";
      state.result_class <- "empty_list"
  | Named_create_ack ->
      state.incarnation <- state.incarnation + 1;
      state.operation <-
        (if state.incarnation = 1 then "created" else "recreated");
      state.result_class <- "created";
      state.live <- true;
      state.attached <- false;
      state.replay_seen <- false;
      state.reused <- state.incarnation > 1;
      state.attachment_mode <- "none";
      state.io_class <- "none";
      state.queue_class <- "none";
      state.size_class <- "not_observed";
      state.client_count <- 0;
      state.fanout_class <- "none"
  | Attach_ack_then_replay ->
      state.operation <-
        (if state.incarnation > 1 then "reattached" else "attached");
      state.result_class <- "replay";
      state.attached <- true;
      state.replay_seen <- true;
      state.attachment_mode <-
        (if state.incarnation > 1 then "replay_after_recreate_no_old_marker"
         else "replay_first");
      state.size_class <- "attach_24x80";
      state.client_count <- 1
  | Geometry_observed size_class ->
      begin match (state.operation, size_class) with
      | "attached", "resize_31x71" -> state.operation <- "resized_first"
      | "resized_first", "resize_33x73" -> state.operation <- "resized_last"
      | _ ->
          failf "unexpected size class %S after %S" size_class state.operation
      end;
      state.result_class <- "geometry_observed";
      state.size_class <- size_class
  | Terminal_output_seen ->
      state.operation <-
        (if state.incarnation > 1 then "reused_input_output" else "input_output");
      state.result_class <- "output";
      state.io_class <-
        (if state.incarnation > 1 then "input_then_output_after_recreate"
         else "input_then_output")
  | Second_attach_replay_seen ->
      if state.operation <> "input_output" || state.client_count <> 1 then
        failwith "second attach outside the one-client input state";
      state.operation <- "attached_second";
      state.result_class <- "replay";
      state.attachment_mode <- "second_replay_first";
      state.client_count <- 2
  | Fanout_seen_by_both ->
      if state.operation <> "attached_second" || state.client_count <> 2 then
        failwith "fanout outside the two-client state";
      state.operation <- "fanout_both";
      state.result_class <- "output";
      state.fanout_class <- "both_observed"
  | Second_detached ->
      if state.operation <> "fanout_both" || state.client_count <> 2 then
        failwith "detach outside the two-client fanout state";
      state.operation <- "detached_second";
      state.result_class <- "detached";
      state.attachment_mode <- "first_survives";
      state.client_count <- 1
  | Surviving_output_seen ->
      if state.operation <> "detached_second" || state.client_count <> 1 then
        failwith "survivor output outside the one-client state";
      state.operation <- "surviving_output";
      state.result_class <- "output";
      state.fanout_class <- "survivor_observed"
  | Drop_report_seen ->
      state.operation <- "overflow";
      state.result_class <- "drop_reported";
      state.queue_class <- "drop_after_second_frame_reported"
  | Exact_input_recovered ->
      state.operation <- "recovered";
      state.result_class <- "exact_input_recovered";
      state.queue_class <- "first_exact_second_dropped_recovery_exact_fifo"
  | Kill_ack_then_exit ->
      state.operation <- "terminated";
      state.result_class <- "exit";
      state.live <- false;
      state.attached <- false;
      state.attachment_mode <- "closed";
      state.client_count <- 0
  end

type instance = {
  input : in_channel;
  output : out_channel;
  errors : in_channel;
  socket : string;
  home : string;
  observation : observation;
  mutable attached_fd : Unix.file_descr option;
  mutable second_fd : Unix.file_descr option;
  mutable closed : bool;
}

let close_fd = function
  | None -> ()
  | Some fd -> ( try Unix.close fd with Unix.Unix_error _ -> ())

let close instance =
  if not instance.closed then begin
    instance.closed <- true;
    close_fd instance.attached_fd;
    instance.attached_fd <- None;
    close_fd instance.second_fd;
    instance.second_fd <- None;
    close_out_noerr instance.output;
    let stderr = In_channel.input_all instance.errors in
    match
      Unix.close_process_full (instance.input, instance.output, instance.errors)
    with
    | Unix.WEXITED 0 -> ()
    | Unix.WEXITED code -> failf "ptyhost harness exited %d: %s" code stderr
    | Unix.WSIGNALED signal ->
        failf "ptyhost harness was signalled %d: %s" signal stderr
    | Unix.WSTOPPED signal ->
        failf "ptyhost harness stopped %d: %s" signal stderr
  end

let create () =
  let python = Option.value (Sys.getenv_opt "PYTHON") ~default:"python3" in
  let input, output, errors =
    Unix.open_process_args_full python
      [| python; harness_path (); "--interop" |]
      (clean_environment ())
  in
  try
    let startup = Yojson.Safe.from_string (read_startup input) in
    {
      input;
      output;
      errors;
      socket = member_string "socket" startup;
      home = member_string "home" startup;
      observation = initial_observation ();
      attached_fd = None;
      second_fd = None;
      closed = false;
    }
  with exn ->
    close_out_noerr output;
    ignore (In_channel.input_all errors);
    ignore (Unix.close_process_full (input, output, errors));
    raise exn

let connect socket =
  let fd = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Unix.connect fd (Unix.ADDR_UNIX socket);
  fd

let request instance payload =
  let fd = connect instance.socket in
  Fun.protect
    ~finally:(fun () -> close_fd (Some fd))
    (fun () ->
      write_frame fd 'C' payload;
      let reply = read_frame fd in
      if not (Char.equal reply.kind 'C') then
        failwith "ptyhost control reply was not C";
      Yojson.Safe.from_string reply.payload)

let list_sessions instance =
  match request instance "{\"op\":\"list\"}" with
  | `List sessions -> sessions
  | _ -> failwith "ptyhost list reply was not an array"

let expect_singleton label expected actual =
  if actual <> expected then
    failf "%s: expected %d sessions, got %d" label expected actual

let expect_named_session label = function
  | [ `Assoc fields ] -> (
      match List.assoc_opt "name" fields with
      | Some (`String name) when String.equal name session_name -> ()
      | Some (`String name) ->
          failf "%s: expected session %S, got %S" label session_name name
      | _ -> failf "%s: listed session had no string name" label)
  | sessions ->
      failf "%s: expected one listed session, got %d" label
        (List.length sessions)

let attached_count label instance =
  match list_sessions instance with
  | [ (`Assoc fields as session) ] ->
      expect_named_session label [ session ];
      begin match List.assoc_opt "attached" fields with
      | Some (`Int count) when count >= 0 && count <= 2 -> count
      | _ -> failf "%s: no bounded attached count" label
      end
  | sessions ->
      failf "%s: expected one listed session, got %d" label
        (List.length sessions)

let expect_attached_count label expected instance =
  let actual = attached_count label instance in
  if actual <> expected then
    failf "%s: expected %d attached clients, got %d" label expected actual

let rec wait_for_attached_count label expected instance remaining =
  if remaining = 0 then expect_attached_count label expected instance
  else if attached_count label instance <> expected then begin
    Unix.sleepf 0.05;
    wait_for_attached_count label expected instance (remaining - 1)
  end

let new_session instance =
  let payload =
    Printf.sprintf "{\"op\":\"new\",\"name\":%s,\"cwd\":%s}"
      (json_string session_name)
      (json_string instance.home)
  in
  match request instance payload with
  | `Assoc fields as reply ->
      if not (reply_ok reply) then failwith "ptyhost refused synthetic session";
      begin match List.assoc_opt "name" fields with
      | Some (`String name) when String.equal name session_name -> ()
      | Some (`String name) ->
          failf "new: expected acknowledgement for %S, got %S" session_name name
      | _ -> failwith "new: acknowledgement had no string name"
      end;
      expect_named_session "new" (list_sessions instance);
      Named_create_ack
  | _ -> failwith "new: ptyhost reply was not an object"

let read_attach_response fd ~fresh =
  let acknowledgement = read_frame fd in
  if not (Char.equal acknowledgement.kind 'C') then
    failwith "attach acknowledgement was not C";
  if not (reply_ok (Yojson.Safe.from_string acknowledgement.payload)) then
    failwith "ptyhost refused synthetic attach";
  let replay = read_frame fd in
  if not (Char.equal replay.kind 'D') then
    failwith "attach did not send its replay frame";
  if fresh && contains replay.payload "MESH_T44_OUT" then
    failwith "reattach replay contained the previous incarnation";
  Attach_ack_then_replay

let attach instance =
  match instance.attached_fd with
  | Some _ -> failwith "synthetic driver attached twice"
  | None -> (
      let fd = connect instance.socket in
      try
        let payload =
          Printf.sprintf
            "{\"op\":\"attach\",\"name\":%s,\"rows\":24,\"cols\":80}"
            (json_string session_name)
        in
        write_frame fd 'C' payload;
        let event =
          read_attach_response fd ~fresh:(instance.observation.incarnation > 1)
        in
        send_and_observe fd
          "stty -echo; printf 'MESH_T44_SIZE:%s\\n' \"$(stty size)\"\r"
          "MESH_T44_SIZE:24 80\r\n";
        (* The synthetic marker is used only to reject stale replay. Neither
           it nor any terminal payload enters the projected observation. *)
        instance.attached_fd <- Some fd;
        expect_attached_count "first attach" 1 instance;
        event
      with exn ->
        close_fd (Some fd);
        raise exn)

let attached_fd instance =
  match instance.attached_fd with
  | Some fd -> fd
  | None -> failwith "synthetic input requires an attached client"

let resize_and_observe instance ~rows ~cols ~size_class =
  let fd = attached_fd instance in
  let payload = Printf.sprintf "{\"rows\":%d,\"cols\":%d}" rows cols in
  write_frame fd 'R' payload;
  send_and_observe fd "printf 'MESH_T44_SIZE:%s\\n' \"$(stty size)\"\r"
    (Printf.sprintf "MESH_T44_SIZE:%d %d\r\n" rows cols);
  Geometry_observed size_class

let input_output instance =
  let fd = attached_fd instance in
  if instance.observation.incarnation = 1 then
    send_and_observe fd "stty -echo; printf 'MESH_T44_READY\\n'\r"
      "MESH_T44_READY\r\n";
  send_and_observe fd "printf 'MESH_T44_OUT\\n'\r" "MESH_T44_OUT\r\n";
  Terminal_output_seen

let read_second_attach_response fd =
  let acknowledgement = read_frame fd in
  if not (Char.equal acknowledgement.kind 'C') then
    failwith "second attach acknowledgement was not C";
  if not (reply_ok (Yojson.Safe.from_string acknowledgement.payload)) then
    failwith "ptyhost refused synthetic second attach";
  let replay = read_frame fd in
  if not (Char.equal replay.kind 'D') then
    failwith "second attach did not send replay before live output";
  if not (contains replay.payload "MESH_T44_OUT\r\n") then
    failwith "second attach replay omitted earlier output";
  Second_attach_replay_seen

let attach_second instance =
  match instance.second_fd with
  | Some _ -> failwith "synthetic driver attached second client twice"
  | None -> (
      let fd = connect instance.socket in
      try
        let payload =
          Printf.sprintf
            "{\"op\":\"attach\",\"name\":%s,\"rows\":33,\"cols\":73}"
            (json_string session_name)
        in
        write_frame fd 'C' payload;
        let event = read_second_attach_response fd in
        instance.second_fd <- Some fd;
        expect_attached_count "second attach" 2 instance;
        event
      with exn ->
        close_fd (Some fd);
        instance.second_fd <- None;
        raise exn)

let second_fd instance =
  match instance.second_fd with
  | Some fd -> fd
  | None -> failwith "synthetic second client is not attached"

let fanout_both instance =
  let first = attached_fd instance in
  let second = second_fd instance in
  write_frame first 'D' "printf 'MESH_T44_FANOUT\\n'\r";
  wait_for_output first "MESH_T44_FANOUT\r\n" 64 "";
  wait_for_output second "MESH_T44_FANOUT\r\n" 64 "";
  expect_attached_count "live fanout" 2 instance;
  Fanout_seen_by_both

let detach_second instance =
  close_fd instance.second_fd;
  instance.second_fd <- None;
  wait_for_attached_count "second detach" 1 instance 100;
  Second_detached

let surviving_output instance =
  send_and_observe (attached_fd instance) "printf 'MESH_T44_SURVIVES\\n'\r"
    "MESH_T44_SURVIVES\r\n";
  expect_attached_count "surviving client" 1 instance;
  Surviving_output_seen

let drop_log_lines path =
  let log = In_channel.with_open_text path In_channel.input_all in
  String.split_on_char '\n' log
  |> List.filter (fun line -> contains line (session_name ^ ": input dropped"))

let pending_bytes_in_drop_report line =
  match String.split_on_char '(' line with
  | [ _; tail ] -> (
      match String.split_on_char ' ' tail with
      | value :: _ -> int_of_string_opt value
      | [] -> None)
  | _ -> None

let rec wait_for_drop_log path baseline remaining =
  if remaining = 0 then failwith "second-frame queue drop was not logged";
  let reports = drop_log_lines path in
  let count = List.length reports in
  if count = baseline + 1 then begin
    let latest = List.nth reports baseline in
    match pending_bytes_in_drop_report latest with
    | Some bytes when bytes >= 5 * 1024 * 1024 -> Drop_report_seen
    | _ -> failwith "drop report cannot be attributed to the second frame"
  end
  else if count > baseline + 1 then
    failwith "queue reported multiple unexpected drop episodes"
  else begin
    Unix.sleepf 0.05;
    wait_for_drop_log path baseline (remaining - 1)
  end

let first_input () =
  String.init
    (6 * 1024 * 1024)
    (fun i -> Char.chr (((i * 73) + (i / 257) + 19) land 255))

let recovery_input () =
  String.init 257 (fun i -> Char.chr (((i * 11) + 7) land 255))

let expect_exact_file label path expected =
  let actual = In_channel.with_open_bin path In_channel.input_all in
  if not (String.equal actual expected) then
    failf "%s: accepted input differs (expected %d bytes, observed %d bytes)"
      label (String.length expected) (String.length actual)

let overflow instance =
  let fd = attached_fd instance in
  send_and_observe fd
    "stty raw -echo -iexten; printf 'MESH_T44_IDLE\\n'; while [ ! -e t44-go ]; \
     do sleep 0.1; done; head -c 6291456 > t44-first.bin; printf \
     'MESH_T44_DRAINED\\n'; head -c 257 > t44-recovery.bin; printf \
     'MESH_T44_RECOVERED\\n'; exec sleep 600\r"
    "MESH_T44_IDLE\n";
  let log_path = Filename.concat instance.home "runtime/ptyhost.stderr" in
  let baseline = List.length (drop_log_lines log_path) in
  write_frame fd 'D' (first_input ());
  Unix.sleepf 0.1;
  if List.length (drop_log_lines log_path) <> baseline then
    failwith "first in-capacity frame unexpectedly reported a drop";
  write_frame fd 'D' (String.make (3 * 1024 * 1024) 'y');
  (* The gated consumer keeps the first frame pending. A named log with >=5 MiB
     pending, absent after frame one, attributes the report to frame two. The
     next action inspects the actual accepted bytes, not this log alone. *)
  let event = wait_for_drop_log log_path baseline 100 in
  expect_named_session "overflow" (list_sessions instance);
  event

let recover instance =
  let fd = attached_fd instance in
  let gate = Filename.concat instance.home "t44-go" in
  let gate_fd =
    Unix.openfile gate [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL ] 0o600
  in
  Unix.close gate_fd;
  wait_for_output fd "MESH_T44_DRAINED\n" 64 "";
  expect_exact_file "first accepted frame"
    (Filename.concat instance.home "t44-first.bin")
    (first_input ());
  write_frame fd 'D' (recovery_input ());
  wait_for_output fd "MESH_T44_RECOVERED\n" 64 "";
  expect_exact_file "recovery after dropped frame"
    (Filename.concat instance.home "t44-recovery.bin")
    (recovery_input ());
  expect_named_session "recovery" (list_sessions instance);
  Exact_input_recovered

let rec wait_for_exit fd remaining =
  if remaining = 0 then failwith "attached client did not receive X";
  match read_frame fd with
  | { Mesh_wire.kind = 'X'; _ } -> ()
  | { Mesh_wire.kind = 'D'; _ } -> wait_for_exit fd (remaining - 1)
  | frame -> failf "attached client received unexpected %C frame" frame.kind

let rec wait_until_absent instance remaining =
  if remaining = 0 then failwith "killed synthetic session remained listed";
  if list_sessions instance = [] then ()
  else begin
    Unix.sleepf 0.05;
    wait_until_absent instance (remaining - 1)
  end

let termination_phase label run =
  try run ()
  with Failure message when message = "ptyhost socket read timed out" ->
    failf "termination %s timed out" label

(* Failure-only diagnostics: never emit paths, PIDs, terminal bytes or arbitrary
   stderr. The list request retains the existing bounded socket deadline. *)
let termination_stderr_category text =
  if
    contains text "readv: file descriptor used after calling close!"
    || contains text "read: file descriptor used after calling close!"
  then "closed-reader"
  else if text = "" then "empty"
  else "other"

let termination_diagnostic instance =
  let listed, owned_present, attached =
    try
      match list_sessions instance with
      | [] -> ("absent", "unknown", "none")
      | [ `Assoc fields ] ->
          let alive =
            match List.assoc_opt "pid" fields with
            | Some (`Int pid) when pid > 0 ->
                string_of_bool (Sys.file_exists (Printf.sprintf "/proc/%d" pid))
            | _ -> "unknown"
          in
          let attached =
            match List.assoc_opt "attached" fields with
            | Some (`Int value) when value >= 0 && value <= 2 ->
                string_of_int value
            | _ -> "unknown"
          in
          ("one", alive, attached)
      | _ -> ("other", "unknown", "unknown")
    with Failure _ | Unix.Unix_error _ | Yojson.Json_error _ ->
      ("unavailable", "unknown", "unknown")
  in
  let stderr_category =
    try
      In_channel.with_open_bin
        (Filename.concat instance.home "runtime/ptyhost.stderr") (fun channel ->
          let bytes = Bytes.create 65536 in
          let count = input channel bytes 0 (Bytes.length bytes) in
          let text = Bytes.sub_string bytes 0 count in
          termination_stderr_category text)
    with Sys_error _ -> "unavailable"
  in
  Printf.sprintf "listed=%s;owned_proc_present=%s;attached=%s;stderr=%s" listed
    owned_present attached stderr_category

let test_termination_phase_diagnostics () =
  List.iter
    (fun (text, expected) ->
      Alcotest.(check string)
        "stderr emits only fixed categories" expected
        (termination_stderr_category text))
    [
      ("", "empty");
      ("readv: file descriptor used after calling close!", "closed-reader");
      ("read: file descriptor used after calling close!", "closed-reader");
      ("synthetic arbitrary private diagnostic", "other");
    ];
  List.iter
    (fun label ->
      Alcotest.check_raises label
        (Failure ("termination " ^ label ^ " timed out"))
        (fun () ->
          termination_phase label (fun () ->
              failwith "ptyhost socket read timed out")))
    [ "kill acknowledgment"; "attached X"; "post-exit control list" ];
  List.iter
    (fun error ->
      Alcotest.check_raises "other diagnostics unchanged" error (fun () ->
          termination_phase "attached X" (fun () -> raise error)))
    [
      Failure "ptyhost socket closed before its reply";
      Invalid_argument "fixture";
    ];
  Alcotest.(check int)
    "successful operation unchanged" 7
    (termination_phase "kill acknowledgment" (fun () -> 7))

let terminate instance =
  if
    not
      (reply_ok
         (termination_phase "kill acknowledgment" (fun () ->
              request instance
                (Printf.sprintf "{\"op\":\"kill\",\"name\":%s}"
                   (json_string session_name)))))
  then failwith "ptyhost refused synthetic kill";
  match instance.attached_fd with
  | None -> failwith "synthetic driver terminated without an attached client"
  | Some fd ->
      Fun.protect
        ~finally:(fun () ->
          close_fd (Some fd);
          instance.attached_fd <- None)
        (fun () ->
          try termination_phase "attached X" (fun () -> wait_for_exit fd 16)
          with
          | Failure message when message = "termination attached X timed out" ->
            failf "%s [%s]" message (termination_diagnostic instance));
      termination_phase "post-exit control list" (fun () ->
          wait_until_absent instance 100);
      Kill_ack_then_exit

module Host_driver = struct
  type t = instance

  let create = create

  let step instance (step : Itf.Step.t) =
    try
      match step.action_name with
      | Some "init" ->
          expect_singleton "init" 0 (List.length (list_sessions instance));
          record_event instance.observation Empty_control_list;
          Ok ()
      | Some "create" ->
          record_event instance.observation (new_session instance);
          Ok ()
      | Some "attach" ->
          record_event instance.observation (attach instance);
          Ok ()
      | Some "resize_first" ->
          record_event instance.observation
            (resize_and_observe instance ~rows:31 ~cols:71
               ~size_class:"resize_31x71");
          Ok ()
      | Some "resize_last" ->
          record_event instance.observation
            (resize_and_observe instance ~rows:33 ~cols:73
               ~size_class:"resize_33x73");
          Ok ()
      | Some "input_output" ->
          record_event instance.observation (input_output instance);
          Ok ()
      | Some "attach_second" ->
          record_event instance.observation (attach_second instance);
          Ok ()
      | Some "fanout_both" ->
          record_event instance.observation (fanout_both instance);
          Ok ()
      | Some "detach_second" ->
          record_event instance.observation (detach_second instance);
          Ok ()
      | Some "surviving_output" ->
          record_event instance.observation (surviving_output instance);
          Ok ()
      | Some "overflow" ->
          record_event instance.observation (overflow instance);
          Ok ()
      | Some "recover" ->
          record_event instance.observation (recover instance);
          Ok ()
      | Some "terminate" ->
          record_event instance.observation (terminate instance);
          Ok ()
      | Some "recreate" ->
          record_event instance.observation (new_session instance);
          Ok ()
      | Some "reattach" ->
          record_event instance.observation (attach instance);
          Ok ()
      | Some "reused_input_output" ->
          record_event instance.observation (input_output instance);
          Ok ()
      | Some action -> Error ("unknown synthetic lifecycle action " ^ action)
      | None -> Error "synthetic lifecycle trace has no action"
    with exn -> Error (Printexc.to_string exn)
end

let abstraction instance =
  let state = instance.observation in
  [
    ("operation", Model_value.str state.operation);
    ("order_index", Model_value.int state.order_index);
    ("result_class", Model_value.str state.result_class);
    ("live", Model_value.bool state.live);
    ("attached", Model_value.bool state.attached);
    ("replay_seen", Model_value.bool state.replay_seen);
    ("reused", Model_value.bool state.reused);
    ("attachment_mode", Model_value.str state.attachment_mode);
    ("io_class", Model_value.str state.io_class);
    ("queue_class", Model_value.str state.queue_class);
    ("size_class", Model_value.str state.size_class);
    ("client_count", Model_value.int state.client_count);
    ("fanout_class", Model_value.str state.fanout_class);
  ]

let projection =
  Projection.
    [
      ("operation", whole);
      ("order_index", whole);
      ("result_class", whole);
      ("live", whole);
      ("attached", whole);
      ("replay_seen", whole);
      ("reused", whole);
      ("attachment_mode", whole);
      ("io_class", whole);
      ("queue_class", whole);
      ("size_class", whole);
      ("client_count", whole);
      ("fanout_class", whole);
    ]

type synthetic_instance = observation

type mutation =
  | Missing_replay
  | Leaked_previous_replay
  | Stale_attachment
  | Wrong_resize_size
  | Reversed_resize_order
  | Missing_second_replay
  | Missing_second_client
  | Missing_fanout
  | Stale_detach_count
  | Missing_survivor_output

let synthetic_step mutation state (step : Itf.Step.t) =
  let event =
    match step.action_name with
    | Some "init" -> Ok Empty_control_list
    | Some "create" | Some "recreate" -> Ok Named_create_ack
    | Some "attach" | Some "reattach" -> Ok Attach_ack_then_replay
    | Some "resize_first" -> Ok (Geometry_observed "resize_31x71")
    | Some "resize_last" -> Ok (Geometry_observed "resize_33x73")
    | Some "input_output" | Some "reused_input_output" ->
        Ok Terminal_output_seen
    | Some "attach_second" -> Ok Second_attach_replay_seen
    | Some "fanout_both" -> Ok Fanout_seen_by_both
    | Some "detach_second" -> Ok Second_detached
    | Some "surviving_output" -> Ok Surviving_output_seen
    | Some "overflow" -> Ok Drop_report_seen
    | Some "recover" -> Ok Exact_input_recovered
    | Some "terminate" -> Ok Kill_ack_then_exit
    | Some action -> Error ("unknown synthetic lifecycle action " ^ action)
    | None -> Error "synthetic lifecycle trace has no action"
  in
  match event with
  | Error _ as error -> error
  | Ok event ->
      let event =
        if
          mutation = Reversed_resize_order
          && step.action_name = Some "resize_first"
        then Geometry_observed "resize_33x73"
        else event
      in
      record_event state event;
      if mutation = Wrong_resize_size && step.action_name = Some "resize_last"
      then state.size_class <- "resize_31x71";
      if mutation = Missing_replay && step.action_name = Some "attach" then
        state.replay_seen <- false;
      if mutation = Leaked_previous_replay && step.action_name = Some "recreate"
      then state.replay_seen <- true;
      if mutation = Stale_attachment && step.action_name = Some "reattach" then
        state.attachment_mode <- "replay_first";
      if
        mutation = Missing_second_replay
        && step.action_name = Some "attach_second"
      then state.attachment_mode <- "replay_first";
      if
        mutation = Missing_second_client
        && step.action_name = Some "attach_second"
      then state.client_count <- 1;
      if mutation = Missing_fanout && step.action_name = Some "fanout_both" then
        state.fanout_class <- "first_only";
      if
        mutation = Stale_detach_count && step.action_name = Some "detach_second"
      then state.client_count <- 2;
      if
        mutation = Missing_survivor_output
        && step.action_name = Some "surviving_output"
      then state.fanout_class <- "both_observed";
      Ok ()

module Missing_replay_driver = struct
  type t = synthetic_instance

  let create = initial_observation
  let step = synthetic_step Missing_replay
end

module Stale_attachment_driver = struct
  type t = synthetic_instance

  let create = initial_observation
  let step = synthetic_step Stale_attachment
end

module Leaked_previous_replay_driver = struct
  type t = synthetic_instance

  let create = initial_observation
  let step = synthetic_step Leaked_previous_replay
end

module Wrong_resize_size_driver = struct
  type t = synthetic_instance

  let create = initial_observation
  let step = synthetic_step Wrong_resize_size
end

module Reversed_resize_order_driver = struct
  type t = synthetic_instance

  let create = initial_observation
  let step = synthetic_step Reversed_resize_order
end

module Missing_second_replay_driver = struct
  type t = synthetic_instance

  let create = initial_observation
  let step = synthetic_step Missing_second_replay
end

module Missing_second_client_driver = struct
  type t = synthetic_instance

  let create = initial_observation
  let step = synthetic_step Missing_second_client
end

module Missing_fanout_driver = struct
  type t = synthetic_instance

  let create = initial_observation
  let step = synthetic_step Missing_fanout
end

module Stale_detach_count_driver = struct
  type t = synthetic_instance

  let create = initial_observation
  let step = synthetic_step Stale_detach_count
end

module Missing_survivor_output_driver = struct
  type t = synthetic_instance

  let create = initial_observation
  let step = synthetic_step Missing_survivor_output
end

let synthetic_abstraction state =
  [
    ("operation", Model_value.str state.operation);
    ("order_index", Model_value.int state.order_index);
    ("result_class", Model_value.str state.result_class);
    ("live", Model_value.bool state.live);
    ("attached", Model_value.bool state.attached);
    ("replay_seen", Model_value.bool state.replay_seen);
    ("reused", Model_value.bool state.reused);
    ("attachment_mode", Model_value.str state.attachment_mode);
    ("io_class", Model_value.str state.io_class);
    ("queue_class", Model_value.str state.queue_class);
    ("size_class", Model_value.str state.size_class);
    ("client_count", Model_value.int state.client_count);
    ("fanout_class", Model_value.str state.fanout_class);
  ]

let describe_outcome = function
  | Conformance.Conformant { steps } ->
      Printf.sprintf "conformant after %d steps" steps
  | Conformance.Failed { step; message } ->
      Printf.sprintf "failed at step %d: %s" step message
  | Conformance.Undecided { cause; step; message } ->
      Printf.sprintf "undecided (%s) at %s: %s"
        (Conformance.cause_to_string cause)
        (match step with
        | None -> "no step"
        | Some value -> string_of_int value)
        message

let selected_host_check () =
  Any_check.projected_driver ~close (module Host_driver) projection abstraction

let test_host_lifecycle_replay () =
  match Quint_test.run_check spec (selected_host_check ()) with
  | Conformance.Conformant { steps = 16 } -> ()
  | outcome ->
      Alcotest.failf "selected host lifecycle trace did not conform: %s"
        (describe_outcome outcome)

let test_missing_replay_is_a_divergence () =
  let check =
    Any_check.projected_driver
      (module Missing_replay_driver)
      projection synthetic_abstraction
  in
  match Quint_test.run_check spec check with
  | Conformance.Failed { step = 2; _ } -> ()
  | outcome ->
      Alcotest.failf "missing replay was not caught: %s"
        (describe_outcome outcome)

let test_wrong_resize_size_is_a_divergence () =
  let check =
    Any_check.projected_driver
      (module Wrong_resize_size_driver)
      projection synthetic_abstraction
  in
  match Quint_test.run_check spec check with
  | Conformance.Failed { step = 4; _ } -> ()
  | outcome ->
      Alcotest.failf "changed final resize was not caught: %s"
        (describe_outcome outcome)

let expect_mutant_divergence label expected_step check =
  match Quint_test.run_check spec check with
  | Conformance.Failed { step; _ } when step = expected_step -> ()
  | outcome ->
      Alcotest.failf "%s did not fail at step %d: %s" label expected_step
        (describe_outcome outcome)

let test_missing_second_replay_is_a_divergence () =
  expect_mutant_divergence "missing second replay" 6
    (Any_check.projected_driver
       (module Missing_second_replay_driver)
       projection synthetic_abstraction)

let test_missing_second_client_is_a_divergence () =
  expect_mutant_divergence "second attach count" 6
    (Any_check.projected_driver
       (module Missing_second_client_driver)
       projection synthetic_abstraction)

let test_missing_fanout_is_a_divergence () =
  expect_mutant_divergence "one-sided fanout" 7
    (Any_check.projected_driver
       (module Missing_fanout_driver)
       projection synthetic_abstraction)

let test_stale_detach_count_is_a_divergence () =
  expect_mutant_divergence "stale detach count" 8
    (Any_check.projected_driver
       (module Stale_detach_count_driver)
       projection synthetic_abstraction)

let test_missing_survivor_output_is_a_divergence () =
  expect_mutant_divergence "missing survivor output" 9
    (Any_check.projected_driver
       (module Missing_survivor_output_driver)
       projection synthetic_abstraction)

let test_reversed_resize_order_fails_closed () =
  let check =
    Any_check.projected_driver
      (module Reversed_resize_order_driver)
      projection synthetic_abstraction
  in
  match Quint_test.run_check spec check with
  | Conformance.Failed { step = 3; _ } -> ()
  | outcome ->
      Alcotest.failf "reversed resize order did not fail closed: %s"
        (describe_outcome outcome)

let test_unknown_size_class_fails_closed () =
  let state = initial_observation () in
  record_event state Named_create_ack;
  record_event state Attach_ack_then_replay;
  match record_event state (Geometry_observed "resize_70000x0") with
  | exception Failure message when contains message "unexpected size class" ->
      ()
  | exception exn ->
      Alcotest.failf "wrong unknown-size rejection: %s" (Printexc.to_string exn)
  | () -> Alcotest.fail "unknown/out-of-bounds size class was accepted"

let expect_fake_attach_rejection ~fresh frames expected =
  let client, fake_server = Unix.socketpair Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Fun.protect
    ~finally:(fun () ->
      close_fd (Some client);
      close_fd (Some fake_server))
    (fun () ->
      List.iter
        (fun (kind, payload) -> write_frame fake_server kind payload)
        frames;
      match read_attach_response client ~fresh with
      | exception Failure message when String.equal message expected -> ()
      | exception exn ->
          Alcotest.failf "wrong rejection for mutated attach frames: %s"
            (Printexc.to_string exn)
      | _ -> Alcotest.fail "mutated attach frames were accepted")

let attach_ok = ('C', "{\"ok\":true}")

let test_swapped_response_order_is_a_divergence () =
  (* The fake peer sends replay D before acknowledgement C. *)
  expect_fake_attach_rejection ~fresh:false
    [ ('D', ""); attach_ok ]
    "attach acknowledgement was not C"

let test_missing_replay_frame_is_rejected () =
  expect_fake_attach_rejection ~fresh:false
    [ attach_ok; ('X', "{\"code\":0}") ]
    "attach did not send its replay frame"

let test_stale_replay_frame_is_rejected () =
  expect_fake_attach_rejection ~fresh:true
    [ attach_ok; ('D', "MESH_T44_OUT") ]
    "reattach replay contained the previous incarnation"

let test_second_replay_missing_marker_is_rejected () =
  let client, fake_server = Unix.socketpair Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Fun.protect
    ~finally:(fun () ->
      close_fd (Some client);
      close_fd (Some fake_server))
    (fun () ->
      write_frame fake_server 'C' "{\"ok\":true}";
      write_frame fake_server 'D' "MESH_T44_OLD\r\n";
      match read_second_attach_response client with
      | exception Failure message
        when String.equal message "second attach replay omitted earlier output"
        ->
          ()
      | exception exn ->
          Alcotest.failf "wrong second replay rejection: %s"
            (Printexc.to_string exn)
      | _ -> Alcotest.fail "second replay without earlier output was accepted")

let test_stale_attachment_is_a_divergence () =
  let check =
    Any_check.projected_driver
      (module Stale_attachment_driver)
      projection synthetic_abstraction
  in
  match Quint_test.run_check spec check with
  | Conformance.Failed { step = 14; _ } -> ()
  | outcome ->
      Alcotest.failf "stale attachment was not caught: %s"
        (describe_outcome outcome)

let test_previous_replay_does_not_survive_recreate () =
  let check =
    Any_check.projected_driver
      (module Leaked_previous_replay_driver)
      projection synthetic_abstraction
  in
  match Quint_test.run_check spec check with
  | Conformance.Failed { step = 13; _ } -> ()
  | outcome ->
      Alcotest.failf "previous replay survived recreate: %s"
        (describe_outcome outcome)

let test_changed_accepted_byte_is_rejected () =
  let path = Filename.temp_file "t44-exact-input-" ".bin" in
  Fun.protect
    ~finally:(fun () -> Sys.remove path)
    (fun () ->
      Out_channel.with_open_bin path (fun output -> output_string output "acb");
      match expect_exact_file "same-length reorder" path "abc" with
      | exception Failure message when contains message "differs" -> ()
      | exception exn ->
          Alcotest.failf "wrong byte mismatch result: %s"
            (Printexc.to_string exn)
      | () -> Alcotest.fail "same-length reordering was accepted")

let test_fixture_is_bounded_and_normalised () =
  match Itf.parse_file fixture with
  | Error message -> Alcotest.failf "fixture did not parse: %s" message
  | Ok [ trace ] ->
      let expected_actions =
        [
          "init";
          "create";
          "attach";
          "resize_first";
          "resize_last";
          "input_output";
          "attach_second";
          "fanout_both";
          "detach_second";
          "surviving_output";
          "overflow";
          "recover";
          "terminate";
          "recreate";
          "reattach";
          "reused_input_output";
        ]
      in
      let expected_fields =
        [
          "attached";
          "attachment_mode";
          "client_count";
          "fanout_class";
          "io_class";
          "live";
          "operation";
          "order_index";
          "queue_class";
          "replay_seen";
          "result_class";
          "reused";
          "size_class";
        ]
      in
      Alcotest.(check int) "sixteen bounded states" 16 (List.length trace);
      List.iter2
        (fun action step ->
          Alcotest.(check (option string))
            "synthetic action" (Some action) step.Itf.Step.action_name;
          Alcotest.(check (list string))
            "no nondeterministic payload" []
            (List.map fst step.Itf.Step.nondet_picks);
          Alcotest.(check (list string))
            "normalised observation fields" expected_fields
            (List.sort String.compare (List.map fst step.Itf.Step.bindings)))
        expected_actions trace
  | Ok _ -> Alcotest.fail "fixture must contain exactly one trace"

(* The daemon cases drive tests/ptyhost_proc.py, which imports pytest. Off
   Linux, where the Python interpreter has no pytest they are skipped with the
   reason; on Linux a missing pytest fails them. *)
let python_has_pytest () =
  let python = Option.value (Sys.getenv_opt "PYTHON") ~default:"python3" in
  Sys.command
    (Filename.quote_command python [ "-c"; "import pytest" ] ~stdout:"/dev/null"
       ~stderr:"/dev/null")
  = 0

let daemon_adapter_tests () =
  if Mesh_platform.platform <> Mesh_platform.Linux && not (python_has_pytest ())
  then (
    (* Printed before Alcotest captures the output, so the reason shows. *)
    print_endline
      "skipped: the explicit daemon adapter needs the Python harness, which \
       needs pytest; $PYTHON (default python3) cannot import it";
    [
      Alcotest.test_case "replays lifecycle through Mesh_wire" `Slow (fun () ->
          Alcotest.skip ());
    ])
  else
    [
      Alcotest.test_case "replays lifecycle through Mesh_wire" `Slow
        test_host_lifecycle_replay;
    ]

let () =
  Alcotest.run "ptyhost-lifecycle-itf"
    [
      ( "synthetic trace",
        [
          Alcotest.test_case "contains only normalised lifecycle facts" `Quick
            test_fixture_is_bounded_and_normalised;
          Alcotest.test_case "detects a missing replay observation" `Quick
            test_missing_replay_is_a_divergence;
          Alcotest.test_case "detects a missing second replay" `Quick
            test_missing_second_replay_is_a_divergence;
          Alcotest.test_case "detects a missing second client" `Quick
            test_missing_second_client_is_a_divergence;
          Alcotest.test_case "detects one-sided live fanout" `Quick
            test_missing_fanout_is_a_divergence;
          Alcotest.test_case "detects a stale detach count" `Quick
            test_stale_detach_count_is_a_divergence;
          Alcotest.test_case "detects missing surviving output" `Quick
            test_missing_survivor_output_is_a_divergence;
          Alcotest.test_case "detects a changed last resize" `Quick
            test_wrong_resize_size_is_a_divergence;
          Alcotest.test_case "rejects reversed resize order" `Quick
            test_reversed_resize_order_fails_closed;
          Alcotest.test_case "rejects an unknown size class" `Quick
            test_unknown_size_class_fails_closed;
          Alcotest.test_case "detects swapped response order" `Quick
            test_swapped_response_order_is_a_divergence;
          Alcotest.test_case "rejects a missing replay frame" `Quick
            test_missing_replay_frame_is_rejected;
          Alcotest.test_case "rejects stale replay bytes" `Quick
            test_stale_replay_frame_is_rejected;
          Alcotest.test_case "rejects second replay without earlier output"
            `Quick test_second_replay_missing_marker_is_rejected;
          Alcotest.test_case "detects stale reattachment" `Quick
            test_stale_attachment_is_a_divergence;
          Alcotest.test_case "resets replay at recreation" `Quick
            test_previous_replay_does_not_survive_recreate;
          Alcotest.test_case "rejects changed accepted bytes" `Quick
            test_changed_accepted_byte_is_rejected;
        ] );
      ( "termination diagnostic",
        [
          Alcotest.test_case
            "distinguishes phases without changing other errors" `Quick
            test_termination_phase_diagnostics;
        ] );
      ("explicit daemon adapter", daemon_adapter_tests ());
    ]
