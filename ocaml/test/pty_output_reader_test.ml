(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Reader = Mesh_pty_support.Mesh_pty_output.Reader

let scope test =
  Eio_main.run (fun env ->
      Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds env#mono_clock 5.)
        (fun () -> Eio.Switch.run (fun sw -> test sw)))

let lifecycle () =
  let reader = Reader.create () in
  Reader.stop reader;
  Reader.stop reader;
  Reader.run reader (fun () -> Alcotest.fail "stopped reader entered");
  Alcotest.check_raises "run consumed even before stop"
    (Invalid_argument "PTY output reader already run") (fun () ->
      Reader.run reader (fun () -> ()))

let actual_pty ?fault sw =
  let terminal = Eio_unix.Pty.open_pty ~sw () in
  let reader = Reader.create () in
  let ready, ready_u = Eio.Promise.create () in
  let resume, resume_u = Eio.Promise.create () in
  let finished, finished_u = Eio.Promise.create () in
  Eio.Fiber.fork ~sw (fun () ->
      let outcome =
        try
          Reader.run reader (fun () ->
              let buffer = Cstruct.create 1 in
              Eio.Flow.read_exact (Eio_unix.Pty.source terminal) buffer;
              Alcotest.(check char)
                "actual PTY output" 'x'
                (Cstruct.get_char buffer 0);
              (* The real host yields between output chunks. Park at precisely that
           boundary before the next actual read, not on a timing assumption. *)
              Eio.Fiber.yield ();
              Eio.Promise.resolve ready_u ();
              Eio.Promise.await resume;
              Option.iter raise fault;
              ignore
                (Eio.Flow.single_read (Eio_unix.Pty.source terminal) buffer));
          Ok ()
        with exn -> Error exn
      in
      Eio.Promise.resolve finished_u outcome);
  Eio_unix.Fd.use_exn "test PTY slave write" (Eio_unix.Pty.tty terminal)
    (fun fd ->
      Alcotest.(check int)
        "slave writes exactly one byte" 1
        (Unix.write_substring fd "x" 0 1));
  Eio.Promise.await ready;
  (terminal, reader, resume_u, finished)

let close_after_output_yield () =
  scope (fun sw ->
      let terminal, reader, resume, finished = actual_pty sw in
      let sibling, sibling_u = Eio.Promise.create () in
      Eio.Fiber.fork ~sw (fun () ->
          Eio.Fiber.yield ();
          Eio.Promise.resolve sibling_u ());
      Reader.stop reader;
      Eio_unix.Fd.close (Eio_unix.Pty.pty terminal);
      Eio.Promise.resolve resume ();
      (match Eio.Promise.await finished with
      | Ok () -> ()
      | Error _ -> Alcotest.fail "native output reader resumed on closed PTY");
      Eio.Promise.await sibling;
      Reader.stop reader)

let programmer_and_fatal () =
  List.iter
    (fun fault ->
      scope (fun sw ->
          let terminal, reader, resume, finished = actual_pty ~fault sw in
          Eio.Promise.resolve resume ();
          (match Eio.Promise.await finished with
          | Error observed when observed = fault -> ()
          | _ -> Alcotest.fail "reader programmer/fatal exception hidden");
          Reader.stop reader;
          Eio_unix.Fd.close (Eio_unix.Pty.pty terminal)))
    [ Invalid_argument "PTY reader programmer error"; Sys.Break; Out_of_memory ]

let foreign_cancel_racing_stop () =
  scope (fun _ ->
      let reader = Reader.create () in
      let foreign = Failure "foreign cancellation" in
      let observed =
        try
          Eio.Cancel.sub (fun context ->
              Reader.run reader (fun () ->
                  Eio.Cancel.cancel context foreign;
                  Eio.Cancel.protect (fun () -> Reader.stop reader);
                  Eio.Fiber.yield ()));
          None
        with Eio.Cancel.Cancelled reason -> Some reason
      in
      match observed with
      | Some reason when reason = foreign -> ()
      | _ -> Alcotest.fail "owned stop hid foreign cancellation")

let () =
  Alcotest.run "PTY output reader"
    [
      ( "reader",
        [
          Alcotest.test_case "stop before start and repeated run" `Quick
            lifecycle;
          Alcotest.test_case "stop actual PTY after output yield" `Quick
            close_after_output_yield;
          Alcotest.test_case "programmer and fatal propagate" `Quick
            programmer_and_fatal;
          Alcotest.test_case "foreign cancellation racing stop propagates"
            `Quick foreign_cancel_racing_stop;
        ] );
    ]
