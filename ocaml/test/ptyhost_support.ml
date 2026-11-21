(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Mesh_pty_support
module Replay = Mesh_pty_replay
module Output = Mesh_pty_output
module Input = Mesh_pty_input

let expect label value = if not value then failwith label
let cap = 2 * 1024 * 1024

let replay label input expected =
  let t = Replay.create () in
  Replay.feed t input;
  expect label (Replay.snapshot t = expected)

let retire_conditional_input () =
  Eio_main.run @@ fun env ->
  Eio.Time.with_timeout_exn (Eio.Stdenv.clock env) 5. @@ fun () ->
  Eio.Switch.run @@ fun sw ->
  let queue = Input.create "conditional-retirement" in
  let began, begin_write = Eio.Promise.create () in
  let never, _ = Eio.Promise.create () in
  let done_, finish = Eio.Promise.create () in
  let output = Buffer.create 64 in
  let live = ref true in
  let module Sink = struct
    type t = unit
    let single_write () buffers =
      let text = String.concat "" (List.map Cstruct.to_string buffers) in
      if text = "blocked" then (
        Buffer.add_string output "bl";
        Eio.Promise.resolve begin_write ();
        Eio.Promise.await never);
      Buffer.add_string output text;
      if text = "fresh" then Eio.Promise.resolve finish ();
      String.length text
    let copy t ~src = Eio.Flow.Pi.simple_copy ~single_write t ~src
  end in
  let sink =
    Eio.Resource.T
      ((), Eio.Resource.handler [Eio.Resource.H (Eio.Flow.Pi.Sink, (module Sink))])
  in
  ignore (Input.enqueue ~current:(fun () -> !live) queue "blocked");
  ignore (Input.enqueue ~current:(fun () -> !live) queue "old-queued");
  ignore (Input.enqueue queue "legacy");
  Eio.Fiber.fork ~sw (fun () -> Input.run queue (Eio.Stdenv.clock env) sink);
  Eio.Promise.await began;
  live := false;
  Input.retire_guarded queue;
  Buffer.add_string output "|new|";
  ignore (Input.enqueue ~current:(fun () -> false) queue "stale-dispatch");
  ignore (Input.enqueue ~current:(fun () -> true) queue "fresh");
  Eio.Promise.await done_;
  expect "retirement joins the blocked write and preserves only legacy/fresh input"
    (Buffer.contents output = "bl|new|legacyfresh");
  Input.close queue

let () =
  retire_conditional_input ();
  replay "empty" "" "";
  replay "unchanged at exact capacity" (String.make cap 'a')
    (String.make cap 'a');
  replay "newline boundary" (String.make cap 'a' ^ "\nlast\n") "last\n";
  replay "CSI crossing cut"
    ("\027[31m" ^ String.make (cap - 2) 'a')
    (String.make (cap - 2) 'a');
  replay "OSC BEL crossing cut"
    ("\027]abc\007" ^ String.make (cap - 3) 'a')
    (String.make (cap - 3) 'a');
  replay "OSC ST crossing cut"
    ("\027]ab\027\\" ^ String.make (cap - 3) 'a')
    (String.make (cap - 3) 'a');
  replay "UTF8 crossing cut"
    ("€" ^ String.make (cap - 1) 'a')
    (String.make (cap - 1) 'a');
  replay "unterminated escape bounded"
    ("\027]" ^ String.make (cap + 10) 'a')
    (String.make cap 'a');
  let split = Replay.create () in
  Replay.feed split "\027]abc";
  Replay.feed split ("\007" ^ String.make (cap - 3) 'a');
  expect "escape crosses reads"
    (Replay.snapshot split = String.make (cap - 3) 'a');
  let size = Mesh_pty_protocol.size in
  expect "decimal strings"
    (size [ ("rows", `String " +33 "); ("cols", `String "77") ] = (33, 77));
  expect "underscore decimal strings"
    (size [ ("rows", `String " +3_3 "); ("cols", `String "7_7") ] = (33, 77));
  expect "large decimal clamp"
    (size [ ("rows", `String (String.make 500 '9')); ("cols", `Float 1e100) ]
    = (65535, 65535));
  List.iter
    (fun value ->
      expect "invalid geometry refuses"
        (try
           ignore (size [ ("rows", value); ("cols", `Int 80) ]);
           false
         with Invalid_argument _ -> true))
    [
      `Float infinity;
      `Float nan;
      `String "3.4";
      `String "0x20";
      `String "";
      `String "_33";
      `String "33_";
      `String "3__3";
      `List [];
    ];
  expect "native negative signal code"
    (Mesh_pty_protocol.signal_code Sys.sigterm = -15);
  Eio_main.run (fun _ ->
      let pending_input = Input.create "capacity-test" in
      let half = String.make (4 * 1024 * 1024) 'i' in
      expect "input first half accepted" (Input.enqueue pending_input half);
      expect "input exact 8 MiB accepted" (Input.enqueue pending_input half);
      expect "input byte beyond 8 MiB refused"
        (not (Input.enqueue pending_input "x"));
      Input.close pending_input;
      expect "closed input refuses new bytes"
        (not (Input.enqueue pending_input "x"));
      let client = Output.create () in
      let maximum = String.make (8 * 1024 * 1024) 'x' in
      expect "exact pending budget accepted" (Output.enqueue client maximum);
      expect "dequeue preserves inflight accounting"
        (Output.next client = Some maximum);
      expect "inflight overflow refused" (not (Output.enqueue client "x"));
      expect "overflow abort resolved"
        (Eio.Promise.is_resolved (Output.aborted client));
      Output.sent client maximum;
      Output.detached client;
      Output.detached client;
      expect "detach resolved once"
        (Eio.Promise.is_resolved (Output.done_ client));
      let client = Output.create () in
      ignore (Output.enqueue client "C");
      ignore (Output.enqueue client "D");
      Output.finish client;
      expect "ordered C" (Output.next client = Some "C");
      Output.sent client "C";
      expect "ordered D" (Output.next client = Some "D");
      Output.sent client "D";
      expect "finish after drain" (Output.next client = None);
      expect "no enqueue after finish" (not (Output.enqueue client "late")));
  print_endline "Replay boundaries and input/output byte accounting passed"
