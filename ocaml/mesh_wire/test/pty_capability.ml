(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Single-domain Linux capability experiment, not a persistent PTY host. *)
module Pty = Eio_unix.Pty

let check = Alcotest.(check bool)

let remaining_budget ~elapsed limit =
  let remaining = limit -. elapsed in
  if remaining <= 0. then raise Eio.Time.Timeout;
  remaining

let deadline_budget_test () =
  Alcotest.(check (float 0.000001))
    "later work gets only the remaining budget" 0.5
    (remaining_budget ~elapsed:3.5 4.);
  Alcotest.(check (float 0.000001))
    "cleanup uses the same start, not another five seconds" 1.
    (remaining_budget ~elapsed:4. 5.);
  let expired =
    try
      ignore (remaining_budget ~elapsed:5. 5.);
      false
    with Eio.Time.Timeout -> true
  in
  check "an expired deadline cannot restart a timeout" true expired

let temporary_directory () =
  let path = Filename.temp_file "mesh-pty-probe-" "" in
  Sys.remove path;
  Unix.mkdir path 0o700;
  Unix.realpath path

let dimension fd rows cols =
  Pty.set_window_size fd { rows; cols; xpixel = 0; ypixel = 0 };
  let actual = Pty.get_window_size fd in
  Alcotest.(check int) "rows" rows actual.rows;
  Alcotest.(check int) "columns" cols actual.cols

let probe env ~withhold =
  let clock = Eio.Stdenv.mono_clock env in
  let started = Eio.Time.Mono.now clock in
  let within limit fn =
    let elapsed =
      Mtime.Span.to_float_ns (Mtime.span started (Eio.Time.Mono.now clock))
      /. 1_000_000_000.
    in
    Eio.Time.Timeout.run_exn
      (Eio.Time.Timeout.seconds clock (remaining_budget ~elapsed limit))
      fn
  in
  let child =
    Unix.realpath
      (Filename.concat
         (Filename.dirname Sys.executable_name)
         "pty_capability_child.py")
  in
  let cwd = temporary_directory () in
  Fun.protect ~finally:(fun () -> Unix.rmdir cwd) @@ fun () ->
  Eio.Switch.run @@ fun sw ->
  let terminal = Pty.open_pty ~sw () in
  let attrs = Pty.Tc.getattr (Pty.tty terminal) in
  Pty.Tc.setattr (Pty.tty terminal) Unix.TCSANOW { attrs with c_echo = false };
  let process =
    within 4. (fun () ->
        Eio_unix.Process.spawn_unix ~sw
          (Eio.Stdenv.process_mgr env)
          ~cwd:Eio.Path.(Eio.Stdenv.fs env / cwd)
          ~login_tty:(Pty.tty terminal) ~fds:[]
          ~env:[| "PATH=/usr/bin:/bin"; "LC_ALL=C"; "HOME=" ^ cwd |]
          [
            "/usr/bin/python3";
            "-I";
            child;
            (if withhold then "withhold" else "normal");
          ])
  in
  let pid = Eio.Process.pid process in
  Fun.protect
    ~finally:(fun () ->
      Unix.kill (-pid) Sys.sighup;
      let status = within 5. (fun () -> Eio.Process.await process) in
      check "explicit process-group HUP" true (status = `Signaled Sys.sighup);
      let reaped =
        try
          ignore (Unix.waitpid [ Unix.WNOHANG ] pid);
          false
        with Unix.Unix_error (Unix.ECHILD, _, _) -> true
      in
      check "recorded child reaped" true reaped)
    (fun () ->
      let reader = Eio.Buf_read.of_flow (Pty.source terminal) ~max_size:4096 in
      let metadata = within 4. (fun () -> Eio.Buf_read.line reader) in
      let open Yojson.Basic.Util in
      let metadata = Yojson.Basic.from_string metadata in
      let integer key = metadata |> member key |> to_int in
      let boolean key = metadata |> member key |> to_bool in
      Alcotest.(check int) "own child PID" pid (integer "pid");
      Alcotest.(check int) "new session leader" pid (integer "sid");
      Alcotest.(check int) "new process group" pid (integer "pgid");
      Alcotest.(check string)
        "requested CWD" cwd
        (metadata |> member "cwd" |> to_string);
      check "TTY on all standard descriptors" true (boolean "tty");
      check "controlling /dev/tty" true (boolean "controlling_tty");
      dimension (Pty.pty terminal) 50 200;
      dimension (Pty.pty terminal) 24 80;
      if withhold then
        let missing =
          try
            ignore (within 1. (fun () -> Eio.Buf_read.line reader));
            false
          with Eio.Time.Timeout -> true
        in
        check "missing READY fails by deadline" true missing
      else (
        Alcotest.(check string)
          "child ready" "READY"
          (within 4. (fun () -> Eio.Buf_read.line reader));
        within 4. (fun () -> Eio.Flow.copy_string "PING\n" (Pty.sink terminal));
        Alcotest.(check string)
          "bidirectional marker" "PONG"
          (within 4. (fun () -> Eio.Buf_read.line reader))))

(* The probe needs only a Unix PTY: it passes on Linux and on macOS. *)
let () =
  check "Unix single-domain probe" true (Sys.os_type = "Unix");
  Eio_main.run @@ fun env ->
  Alcotest.run "pty-capability"
    [
      ( "deadline",
        [
          Alcotest.test_case "one budget across stages" `Quick
            deadline_budget_test;
        ] );
      ( "isolated PTY",
        [
          Alcotest.test_case "metadata, I/O, dimensions, HUP/reap" `Quick
            (fun () -> probe env ~withhold:false);
          Alcotest.test_case "withheld marker fails boundedly, then HUP/reap"
            `Quick (fun () -> probe env ~withhold:true);
        ] );
    ]
