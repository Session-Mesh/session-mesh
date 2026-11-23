(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let check name expected actual = Alcotest.(check bool) name expected actual
module Mesh_pty_input = Mesh_pty_support.Mesh_pty_input

let fence_queue () =
  let t = Mesh_pty_input.create "test" in
  check "pending input admitted" true (Mesh_pty_input.enqueue t "pending");
  check "pending queue prevents acquisition" false (Mesh_pty_input.acquire_fence t);
  check "pending was not discarded" true (Mesh_pty_input.enqueue t "more");
  Mesh_pty_input.close t

let fence_admission () =
  let t = Mesh_pty_input.create "test" in
  check "empty input acquired" true (Mesh_pty_input.acquire_fence t);
  check "another acquisition refused" false (Mesh_pty_input.acquire_fence t);
  check "data refused" false (Mesh_pty_input.enqueue t "typed");
  check "wake refused" false (Mesh_pty_input.enqueue_submit t "notice");
  check "owned start queued" true (Mesh_pty_input.enqueue_fenced t "start\r");
  check "queued start not overwritten" false (Mesh_pty_input.enqueue t "typed");
  check "queued control must drain first" false
    (Mesh_pty_input.release_fence t);
  (* The test has no writer, so closing leaves the fence held. *)
  Mesh_pty_input.close t;
  let t = Mesh_pty_input.create "test" in
  check "empty fence acquired" true (Mesh_pty_input.acquire_fence t);
  check "explicit release" true (Mesh_pty_input.release_fence t);
  check "input resumes" true (Mesh_pty_input.enqueue t "typed");
  Mesh_pty_input.close t

let fenced_control ~fail_write () =
  Eio_posix.run (fun env ->
      Eio.Switch.run (fun sw ->
          let t = Mesh_pty_input.create "test" in
          let output = Buffer.create 32 in
          let written, signal = Eio.Promise.create () in
          let stopped, stop = Eio.Promise.create () in
          let module Sink = struct
            type t = unit
            let single_write () buffers =
              if fail_write then raise (Unix.Unix_error (Unix.EIO, "test-write", ""));
              List.iter (fun b -> Buffer.add_string output (Cstruct.to_string b)) buffers;
              Eio.Promise.resolve signal ();
              List.fold_left (fun n b -> n + Cstruct.length b) 0 buffers
            let copy t ~src = Eio.Flow.Pi.simple_copy ~single_write t ~src
          end in
          let sink =
            Eio.Resource.T
              ((), Eio.Resource.handler
                [ Eio.Resource.H (Eio.Flow.Pi.Sink, (module Sink)) ])
          in
          check "acquired" true (Mesh_pty_input.acquire_fence t);
          Eio.Fiber.fork ~sw (fun () ->
              Mesh_pty_input.run t (Eio.Stdenv.clock env) sink;
              Eio.Promise.resolve stop ());
          check "owned control accepted" true
            (Mesh_pty_input.enqueue_fenced t "start\r");
          check "human input still refused" false (Mesh_pty_input.enqueue t "human\r");
          Eio.Time.with_timeout_exn (Eio.Stdenv.clock env) 0.5
            (fun () -> Eio.Promise.await (if fail_write then stopped else written));
          Alcotest.(check string) "control bytes observed" (if fail_write then "" else "start\r")
            (Buffer.contents output);
          check "only a drained open writer releases" (not fail_write)
            (Mesh_pty_input.release_fence t);
          Mesh_pty_input.close t))

let in_flight_write () =
  Eio_posix.run (fun env ->
      Eio.Switch.run (fun sw ->
          let t = Mesh_pty_input.create "test" in
          let writing, began = Eio.Promise.create () in
          let release, allow = Eio.Promise.create () in
          let module Sink = struct
            type t = unit
            let single_write () buffers =
              Eio.Promise.resolve began ();
              Eio.Promise.await release;
              List.fold_left (fun size b -> size + Cstruct.length b) 0 buffers
            let copy t ~src = Eio.Flow.Pi.simple_copy ~single_write t ~src
          end in
          let sink =
            Eio.Resource.T
              ((), Eio.Resource.handler
                [ Eio.Resource.H (Eio.Flow.Pi.Sink, (module Sink)) ])
          in
          Eio.Fiber.fork ~sw (fun () ->
              Mesh_pty_input.run t (Eio.Stdenv.clock env) sink);
          check "admitted before acquisition" true (Mesh_pty_input.enqueue t "first");
          Eio.Promise.await writing;
          check "cannot fence in-flight write" false
            (Mesh_pty_input.acquire_fence t);
          Eio.Promise.resolve allow ();
          let rec wait attempts =
            if Mesh_pty_input.acquire_fence t then ()
            else if attempts = 0 then failwith "writer did not drain"
            else (Eio.Fiber.yield (); wait (attempts - 1))
          in
          wait 100;
          check "subsequent input refused" false (Mesh_pty_input.enqueue t "second");
          Mesh_pty_input.close t))

let () =
  Alcotest.run "pty_input_fence"
    [ ("fence", [ Alcotest.test_case "pending stays pending" `Quick fence_queue;
                   Alcotest.test_case "admission and release" `Quick fence_admission;
                    Alcotest.test_case "control drains before release" `Quick (fenced_control ~fail_write:false);
                    Alcotest.test_case "failed control write cannot release" `Quick (fenced_control ~fail_write:true);
                   Alcotest.test_case "in-flight write is not a checkpoint" `Quick in_flight_write ]) ]
