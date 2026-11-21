(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The terminal modes a stream of output leaves set, as the sequences that
   restore them on a terminal at its defaults. *)

module M = Mesh_pty_support.Mesh_pty_modes

let modes_of chunks =
  let t = M.create () in
  List.iter (M.feed_string t) chunks;
  t

let prefix_of chunks = M.prefix (modes_of chunks)

let check label expected chunks =
  Alcotest.(check string) label expected (prefix_of chunks)

let csi body = "\027[" ^ body
let set n = csi (Printf.sprintf "?%dh" n)
let reset n = csi (Printf.sprintf "?%dl" n)

let defaults () =
  check "nothing at the start" "" [];
  check "text and colours" "" [ "hello \027[1;31mred\027[0m\r\n" ];
  check "set then reset" "" [ set 1049; set 1000; reset 1000; reset 1049 ];
  check "defaults restated" "" [ set 7; set 25 ]

let pi_fullscreen () =
  check "the modes pi sets at startup"
    (set 1049 ^ reset 7 ^ set 1004 ^ set 1003 ^ set 1006)
    [ set 1049; reset 7; set 1000; set 1002; set 1003; set 1004; set 1006 ]

let alternate_screen_first () =
  check "set last, restored first"
    (set 1049 ^ set 2004 ^ set 1000 ^ set 1006)
    [ set 1000; set 1006; set 2004; set 47 ];
  check "1047 too" (set 1049) [ set 1047 ];
  check "left by any of them" "" [ set 1049; reset 47 ]

let every_tracked_mode () =
  check "booleans in a fixed order"
    (set 1 ^ reset 7 ^ reset 25 ^ set 1004 ^ set 1007 ^ set 2004)
    [ set 2004; set 1007; set 1004; reset 25; reset 7; set 1 ];
  check "keypad" "\027=" [ "\027=" ];
  check "keypad off" "" [ "\027=\027>" ];
  check "keypad as mode 66" "\027=" [ set 66 ];
  check "x10 mouse" (set 9) [ set 9 ];
  check "utf-8 and urxvt encodings, ignored by xterm.js" ""
    [ set 1005; set 1015 ];
  check "they do not replace SGR" (set 1006) [ set 1006; set 1015; set 1005 ];
  check "sgr pixels" (set 1016) [ set 1016 ];
  check "untracked modes" "" [ set 12; set 2026; csi "4h"; csi "?1048h" ]

let parameter_lists () =
  check "several modes in one sequence"
    (set 1049 ^ set 1000 ^ set 1006)
    [ csi "?1049;1000;1006h" ];
  check "the last tracking mode of a list wins" (set 1003) [ csi "?1002;1003h" ];
  check "reset of a list" (set 1006) [ csi "?1000;1006h"; csi "?1000;2004l" ];
  check "inside a longer sequence"
    (set 1049 ^ set 1000)
    [ csi "?12;;1049;99999999999999999999;1000;2026h" ];
  check "empty parameters" (set 1006) [ csi "?;1006;h" ];
  check "an ignored encoding reset keeps SGR" (set 1006)
    [ set 1006; reset 1015 ];
  check "resetting 1006 or 1016 restores the default" ""
    [ set 1016; reset 1006 ];
  check "sub-parameters are ignored"
    (set 1049 ^ set 1006)
    [ csi "?1049:1;1006:2:3h" ];
  check "any tracking reset clears tracking" "" [ set 1003; reset 1000 ]

let not_decset () =
  check "ANSI mode, not DEC private" "" [ csi "1049h"; csi "25l" ];
  check "other private leaders" "" [ csi ">1049h"; csi "=1000h"; csi "<1006h" ];
  check "a late question mark" "" [ csi "1?1049h" ];
  check "an intermediate byte" "" [ csi "?1049 h"; csi "?1000$h" ];
  check "other finals" "" [ csi "?1049r"; csi "?1000s"; csi "?1006p" ];
  check "an OSC title" "" [ "\027]0;[?1049h\007" ];
  check "a charset designation is no reset" (set 1049) [ set 1049; "\027(c" ]

let cancelled_sequences () =
  check "CAN aborts" "" [ csi "?1049\024h" ];
  check "SUB aborts" "" [ csi "?1049\026h" ];
  check "ESC restarts" (set 1000) [ csi "?1049\027[?1000h" ];
  check "C0 controls inside are executed, not aborting" (set 1049)
    [ csi "?10\r\n49h" ];
  check "an eight-bit byte aborts" "" [ csi "?1049\200h" ];
  check "unfinished" "" [ csi "?1049" ]

let resets () =
  let all =
    [ set 1049; set 1003; set 1006; set 2004; set 1; reset 25; "\027=" ]
  in
  check "RIS restores every default" "" (all @ [ "\027c" ]);
  check "DECSTR keeps the screen and the mouse"
    (set 1049 ^ set 1003 ^ set 1006)
    (all @ [ csi "!p" ]);
  check "DECSTR parameters are ignored, as by xterm.js"
    (set 1049 ^ set 1003 ^ set 1006)
    (all @ [ csi "1!p" ]);
  check "a private DECSTR is not one"
    (M.prefix (modes_of all))
    (all @ [ csi "?!p" ]);
  check "modes set after a reset" (set 2004) [ set 1000; "\027c"; set 2004 ]

let huge_parameters () =
  let digits = String.make 1_000_000 '9' in
  check "a million digits" (set 1006) [ csi ("?" ^ digits ^ ";1006h") ];
  let many = String.concat "" (List.init 200_000 (fun _ -> "1;")) in
  check "two hundred thousand parameters: the first 32 count" (set 1)
    [ csi ("?" ^ many ^ "1049h") ];
  let parameters n = String.concat "" (List.init n (fun _ -> "12;")) in
  check "a mode as 32nd parameter" (set 1049)
    [ csi ("?" ^ parameters 31 ^ "1049h") ];
  check "a mode as 33rd parameter" "" [ csi ("?" ^ parameters 32 ^ "1049h") ];
  let words = Obj.reachable_words (Obj.repr (modes_of [ csi ("?" ^ many) ])) in
  Alcotest.(check bool) "the state stays small" true (words < 64)

(* A recorded stream with every kind of sequence the scanner follows. *)
let recorded =
  String.concat ""
    [
      "prompt$ ";
      set 1049;
      "\027[H\027[2J";
      csi "?1000;1002;1003h";
      csi "?1006h";
      "\027]0;title\007";
      "\027=";
      csi "?2004h";
      "line \027[1;31mred\027[0m\r\n";
      csi "?25l";
      csi "?1049\024ignored";
      csi "?7l";
      "\027(B";
      csi "!p";
      csi "?1004;1007h";
      "\027c";
      csi "?1049;1003;1015h";
      csi "?12;99999999999;1hX";
      csi "?1015l";
      "\027>";
      csi "?6";
    ]

let split_everywhere () =
  let whole = modes_of [ recorded ] in
  let n = String.length recorded in
  for i = 0 to n do
    for j = i to n do
      let parts =
        [
          String.sub recorded 0 i;
          String.sub recorded i (j - i);
          String.sub recorded j (n - j);
        ]
      in
      if not (M.equal whole (modes_of parts)) then
        Alcotest.failf "split at %d and %d: %S <> %S" i j (prefix_of parts)
          (M.prefix whole)
    done
  done;
  let bytewise = M.create () in
  String.iter (fun c -> M.feed_string bytewise (String.make 1 c)) recorded;
  Alcotest.(check bool) "byte by byte" true (M.equal whole bytewise);
  Alcotest.(check string)
    "the recorded final modes"
    (set 1049 ^ set 1 ^ set 1003)
    (M.prefix whole)

let random_streams () =
  let alphabet = "\027[?;0123456789hl!pc=>\024\r\n:x$ 1049" in
  let state = Random.State.make [| 1903 |] in
  for _ = 1 to 2000 do
    let n = Random.State.int state 200 in
    let text =
      String.init n (fun _ ->
          alphabet.[Random.State.int state (String.length alphabet)])
    in
    let whole = modes_of [ text ] in
    let cut = Random.State.int state (n + 1) in
    let parts = [ String.sub text 0 cut; String.sub text cut (n - cut) ] in
    if not (M.equal whole (modes_of parts)) then
      Alcotest.failf "random split of %S at %d" text cut
  done

let slices () =
  let t = M.create () in
  let bytes = Bytes.of_string (set 1049 ^ set 2004 ^ set 1000) in
  let first = String.length (set 1049) in
  M.feed t bytes first (String.length (set 2004));
  Alcotest.(check string) "only the slice" (set 2004) (M.prefix t);
  Alcotest.check_raises "outside the bytes"
    (Invalid_argument "Mesh_pty_modes.feed") (fun () ->
      M.feed t bytes 4 (Bytes.length bytes))

(* Ordinary output is scanned a word at a time: an ESC at any alignment,
   after a run of any length, is found. *)
let every_alignment () =
  for before = 0 to 40 do
    for offset = 0 to 9 do
      let text =
        String.make (offset + before) 'x' ^ set 1049 ^ String.make 17 'y'
      in
      let t = M.create () in
      M.feed t (Bytes.of_string text) offset (String.length text - offset);
      Alcotest.(check string)
        (Printf.sprintf "after %d bytes from offset %d" before offset)
        (set 1049) (M.prefix t)
    done
  done

let scanning_does_not_allocate () =
  let t = M.create () in
  let text =
    Bytes.of_string
      (String.concat ""
         (List.init 1000 (fun _ -> recorded ^ String.make 4096 'x')))
  in
  let before = Gc.minor_words () in
  M.feed t text 0 (Bytes.length text);
  let words = Gc.minor_words () -. before in
  if words > 100. then Alcotest.failf "scanning allocated %.0f words" words

let () =
  Alcotest.run "PTY terminal modes"
    [
      ( "modes",
        [
          Alcotest.test_case "defaults give no prefix" `Quick defaults;
          Alcotest.test_case "pi fullscreen" `Quick pi_fullscreen;
          Alcotest.test_case "alternate screen first" `Quick
            alternate_screen_first;
          Alcotest.test_case "every tracked mode" `Quick every_tracked_mode;
          Alcotest.test_case "parameter lists" `Quick parameter_lists;
          Alcotest.test_case "not DECSET" `Quick not_decset;
          Alcotest.test_case "cancelled sequences" `Quick cancelled_sequences;
          Alcotest.test_case "RIS and DECSTR" `Quick resets;
        ] );
      ( "robustness",
        [
          Alcotest.test_case "huge parameters" `Quick huge_parameters;
          Alcotest.test_case "split at every pair of offsets" `Quick
            split_everywhere;
          Alcotest.test_case "random streams split anywhere" `Quick
            random_streams;
          Alcotest.test_case "a slice of bytes" `Quick slices;
          Alcotest.test_case "an ESC at every alignment" `Quick every_alignment;
          Alcotest.test_case "scanning does not allocate" `Quick
            scanning_does_not_allocate;
        ] );
    ]
