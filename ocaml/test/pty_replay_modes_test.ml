(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* A replay cut at two MiB no longer holds the sequences a full-screen program
   sent at startup. What a client attaching then receives starts with the
   modes the output had left set where the window starts, then the window. *)

module L = Mesh_pty_support.Mesh_pty_replay

let set n = Printf.sprintf "\027[?%dh" n
let reset n = Printf.sprintf "\027[?%dl" n
let fullscreen = set 1049 ^ set 1000 ^ set 1002 ^ set 1003 ^ set 1006
let fullscreen_prefix = set 1049 ^ set 1003 ^ set 1006
let line = String.make 99 'x' ^ "\n"

(* More than the capacity, in reads of 64 KiB as the host makes them. *)
let churn replay =
  let read = String.concat "" (List.init 655 (fun _ -> line)) in
  for _ = 1 to 40 do
    L.feed replay read
  done

let starts_with ~prefix text =
  String.length text >= String.length prefix
  && String.sub text 0 (String.length prefix) = prefix

let uncut_window_is_unchanged () =
  let replay = L.create () in
  L.feed replay fullscreen;
  L.feed replay "frame\r\n";
  Alcotest.(check string)
    "the bytes, no prefix" (L.snapshot replay) (L.replay replay);
  Alcotest.(check string)
    "the whole output" (fullscreen ^ "frame\r\n") (L.replay replay)

let cut_window_gets_the_modes () =
  let replay = L.create () in
  L.feed replay fullscreen;
  churn replay;
  let snapshot = L.snapshot replay in
  Alcotest.(check bool)
    "the startup sequences are gone" false
    (starts_with ~prefix:fullscreen snapshot);
  Alcotest.(check string)
    "prefix then window"
    (fullscreen_prefix ^ snapshot)
    (L.replay replay)

let cut_window_without_modes () =
  let replay = L.create () in
  churn replay;
  Alcotest.(check string)
    "no mode set: the window alone" (L.snapshot replay) (L.replay replay)

(* The prefix is the state where the window starts, not the last state: a
   mode changed inside the window is changed again by the window itself, and
   output written on the alternate screen is parsed there. *)
let state_at_the_window_start () =
  let replay = L.create () in
  L.feed replay fullscreen;
  churn replay;
  L.feed replay (reset 1049 ^ reset 1003 ^ "back on the shell\n");
  let window = L.snapshot replay in
  Alcotest.(check string)
    "the window start was on the alternate screen"
    (fullscreen_prefix ^ window)
    (L.replay replay);
  churn replay;
  Alcotest.(check string)
    "once the exit is trimmed too" (set 1006)
    (String.sub (L.replay replay) 0 (String.length (set 1006)));
  Alcotest.(check string)
    "and nothing else"
    (set 1006 ^ L.snapshot replay)
    (L.replay replay)

let reset_before_the_cut () =
  let replay = L.create () in
  L.feed replay fullscreen;
  L.feed replay "\027c";
  L.feed replay (set 2004);
  churn replay;
  Alcotest.(check string)
    "only what followed the reset"
    (set 2004 ^ L.snapshot replay)
    (L.replay replay)

(* Sequences split across reads, at the trim boundary included. *)
let split_reads () =
  let replay = L.create () in
  L.feed replay "\027[?10";
  L.feed replay "49;100";
  L.feed replay "3h\027";
  L.feed replay "[?1006";
  L.feed replay "h";
  churn replay;
  Alcotest.(check string)
    "every split sequence counted"
    (fullscreen_prefix ^ L.snapshot replay)
    (L.replay replay)

(* A line feed inside a sequence is executed, not an end: the window can be
   cut there. The end of that sequence is applied to the prefix, not sent. *)
let cut_inside_a_sequence () =
  let replay = L.create () in
  L.feed replay (set 1049);
  L.feed replay (String.make (2 * 1024 * 1024) 'x');
  L.feed replay "\027[?10\n49l";
  L.feed replay "tail\n";
  Alcotest.(check string)
    "the window starts inside the sequence" "49ltail\n" (L.snapshot replay);
  Alcotest.(check string) "its end applied, not sent" "tail\n" (L.replay replay)

(* A sequence cancelled by a new ESC at the start of the window: the new
   sequence (a colour here) is sent, not consumed. *)
let cancelled_at_the_cut () =
  let replay = L.create () in
  L.feed replay (set 1049);
  L.feed replay (String.make (2 * 1024 * 1024) 'x');
  L.feed replay "\027[?10\n\027[31mred\n";
  Alcotest.(check string)
    "the cancelled sequence does not apply; the colour is kept"
    "\027[?1049h\027[31mred\n" (L.replay replay)

(* A title, a DCS payload or an APC cut after a line feed: the rest of the
   string is not shown as text. *)
let string_cut_at_the_line_feed () =
  let cut_inside opening rest =
    let replay = L.create () in
    L.feed replay (set 2004);
    L.feed replay (String.make (2 * 1024 * 1024) 'x');
    L.feed replay (opening ^ "\n" ^ rest);
    L.replay replay
  in
  Alcotest.(check string)
    "an OSC title"
    (set 2004 ^ "after\n")
    (cut_inside "\027]0;head" "TAIL\007after\n");
  Alcotest.(check string)
    "a DCS payload: ST is sent"
    (set 2004 ^ "\027\\after\n")
    (cut_inside "\027Pq#0" "#1\027\\after\n");
  Alcotest.(check string)
    "an APC past a BEL"
    (set 2004 ^ "after\n")
    (cut_inside "\027_x" "y\007z\194\156after\n");
  Alcotest.(check string)
    "a mode switch ends the title and is sent"
    (set 2004 ^ set 1049 ^ "\n")
    (cut_inside "\027]0;head" "TAIL\027[?1049h\n")

(* An unfinished sequence longer than the scan leaves the window whole. *)
let unfinished_sequence_at_the_cut () =
  let replay = L.create () in
  L.feed replay (set 2004);
  L.feed replay (String.make (2 * 1024 * 1024) 'x');
  L.feed replay "\027[?1\n";
  L.feed replay (String.make 5000 '0');
  Alcotest.(check string)
    "the prefix and the whole window"
    (set 2004 ^ L.snapshot replay)
    (L.replay replay)

let late_clients_see_their_own_start () =
  let replay = L.create () in
  let early = L.replay replay in
  L.feed replay fullscreen;
  churn replay;
  let late = L.replay replay in
  L.feed replay (reset 1049 ^ reset 1000 ^ reset 1006 ^ "\n");
  churn replay;
  let later = L.replay replay in
  Alcotest.(check string) "a client attached at the start: nothing" "" early;
  Alcotest.(check bool)
    "a late client: the fullscreen modes" true
    (starts_with ~prefix:fullscreen_prefix late);
  Alcotest.(check string)
    "a later client: the window alone" (L.snapshot replay) later

let () =
  Alcotest.run "PTY replay modes"
    [
      ( "replay",
        [
          Alcotest.test_case "an uncut window is unchanged" `Quick
            uncut_window_is_unchanged;
          Alcotest.test_case "a cut window gets the modes" `Quick
            cut_window_gets_the_modes;
          Alcotest.test_case "a cut window without modes" `Quick
            cut_window_without_modes;
          Alcotest.test_case "the state where the window starts" `Quick
            state_at_the_window_start;
          Alcotest.test_case "a reset before the cut" `Quick
            reset_before_the_cut;
          Alcotest.test_case "sequences split across reads" `Quick split_reads;
          Alcotest.test_case "a cut inside a sequence" `Quick
            cut_inside_a_sequence;
          Alcotest.test_case "an unfinished sequence at the cut" `Quick
            unfinished_sequence_at_the_cut;
          Alcotest.test_case "a sequence cancelled at the cut" `Quick
            cancelled_at_the_cut;
          Alcotest.test_case "a string cut after a line feed" `Quick
            string_cut_at_the_line_feed;
          Alcotest.test_case "clients attaching at different times" `Quick
            late_clients_see_their_own_start;
        ] );
    ]
