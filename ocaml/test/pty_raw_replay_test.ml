(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module R = Mesh_pty_support.Mesh_pty_replay.Raw

let ok = function Ok x -> x | Error _ -> Alcotest.fail "unexpected refusal"
let read t offset maximum = ok (R.read t ~offset ~maximum)

let check_bytes expected actual =
  Alcotest.(check string) "exact bytes" expected actual

let wrap () =
  let ring = R.create () in
  ignore (ok (R.append ring (String.make R.capacity 'x')));
  ignore (ok (R.append ring "\000\255abcd"));
  Alcotest.(check int64) "floor" 6L (R.floor ring);
  check_bytes "\000\255abcd" (fst (read ring (Int64.of_int R.capacity) 32768));
  check_bytes "xx\000\255abcd"
    (fst (read ring (Int64.of_int (R.capacity - 2)) 32768));
  Alcotest.(check bool)
    "gap" true
    (R.read ring ~offset:5L ~maximum:1 = Error R.Gap);
  Alcotest.(check bool)
    "future" true
    (R.read ring ~offset:(Int64.succ (R.head ring)) ~maximum:1
    = Error R.Invalid_cursor)

let large () =
  let ring = R.create () in
  let bytes =
    String.init ((3 * R.capacity) + 17) (fun n -> Char.chr (n mod 256))
  in
  ignore (ok (R.append ring bytes));
  Alcotest.(check int64)
    "head includes discarded prefix"
    (Int64.of_int (String.length bytes))
    (R.head ring);
  Alcotest.(check int64)
    "bounded retained span" (Int64.of_int R.capacity)
    (Int64.sub (R.head ring) (R.floor ring));
  check_bytes
    (String.sub bytes (String.length bytes - R.capacity) 32768)
    (fst (read ring (R.floor ring) 32768));
  check_bytes
    (String.sub bytes (String.length bytes - 10) 10)
    (fst (read ring (Int64.sub (R.head ring) 10L) 32768))

let tiny () =
  let ring = R.create () in
  for _ = 1 to 10000 do
    ignore (ok (R.append ring "x"))
  done;
  Alcotest.(check int64) "tiny writes head" 10000L (R.head ring);
  check_bytes (String.make 10000 'x') (fst (read ring 0L 32768))

let replay () =
  let ring = R.create () in
  Alcotest.(check bool)
    "mark before append refused" true
    (R.mark_initial_replay ring = Error R.Invalid_state);
  ignore (ok (R.append ring "old"));
  ignore (ok (R.mark_initial_replay ring));
  Alcotest.(check bool)
    "repeated mark refused" true
    (R.mark_initial_replay ring = Error R.Invalid_state);
  ignore (ok (R.append ring "new"));
  Alcotest.(check (pair string bool))
    "replay stops exactly" ("old", true) (read ring 0L 6);
  Alcotest.(check (pair string bool))
    "new output not replay" ("new", false) (read ring 3L 6);
  Alcotest.(check (pair string bool))
    "empty not replay" ("", false) (read ring 6L 6);
  let empty = R.create () in
  ignore (ok (R.append empty ""));
  ignore (ok (R.mark_initial_replay empty));
  ignore (ok (R.append empty "live"));
  Alcotest.(check (pair string bool))
    "empty first snapshot" ("live", false) (read empty 0L 10);
  let late = R.create () in
  ignore (ok (R.append late "a"));
  ignore (ok (R.append late "b"));
  Alcotest.(check bool)
    "late mark refused" true
    (R.mark_initial_replay late = Error R.Invalid_state);
  let late_empty = R.create () in
  ignore (ok (R.append late_empty "a"));
  ignore (ok (R.append late_empty ""));
  Alcotest.(check bool)
    "empty second append is still late" true
    (R.mark_initial_replay late_empty = Error R.Invalid_state)

let arithmetic () =
  Alcotest.(check bool)
    "overflow" true
    (R.checked_advance ~offset:Int64.max_int ~length:1 = Error R.Overflow);
  Alcotest.(check int64)
    "exact max" Int64.max_int
    (ok (R.checked_advance ~offset:(Int64.pred Int64.max_int) ~length:1));
  Alcotest.(check int64)
    "zero at max" Int64.max_int
    (ok (R.checked_advance ~offset:Int64.max_int ~length:0));
  List.iter
    (fun (offset, length) ->
      Alcotest.(check bool)
        "negative refused" true
        (R.checked_advance ~offset ~length = Error R.Invalid_cursor))
    [ (-1L, 1); (0L, -1) ];
  let ring = R.create () in
  ignore (ok (R.append ring "safe"));
  List.iter
    (fun (offset, maximum) ->
      Alcotest.(check bool)
        "bad read refused" true
        (R.read ring ~offset ~maximum = Error R.Invalid_cursor))
    [ (-1L, 1); (0L, 0); (0L, 32769); (5L, 1) ];
  check_bytes "safe" (fst (read ring 0L 10));
  Alcotest.(check int64) "invalid reads no head mutation" 4L (R.head ring)

let legacy () =
  let module L = Mesh_pty_support.Mesh_pty_replay in
  let ring = L.create () in
  L.feed ring "legacy\000\255";
  check_bytes "legacy\000\255" (L.snapshot ring)

let birth_history () =
  let module L = Mesh_pty_support.Mesh_pty_replay in
  let ring = L.create () in
  Alcotest.(check (option string))
    "empty birth is complete" (Some "") (L.birth_bytes ring);
  let binary = "first\000\255\027[31m" in
  L.feed ring binary;
  L.feed ring "second";
  Alcotest.(check (option string))
    "opaque full history from birth"
    (Some (binary ^ "second"))
    (L.birth_bytes ring);
  L.feed ring (String.make (2 * 1024 * 1024) 'x' ^ "\n");
  Alcotest.(check (option string))
    "trim destroys birth completeness" None (L.birth_bytes ring);
  Alcotest.(check string)
    "newline trim leaves empty retained suffix" "" (L.snapshot ring);
  L.feed ring "new tail";
  Alcotest.(check (option string))
    "new suffix cannot restore birth" None (L.birth_bytes ring);
  check_bytes "new tail" (L.snapshot ring)

let () =
  Alcotest.run "raw PTY replay"
    [
      ( "bytes",
        [
          Alcotest.test_case "wrap and cursor refusal" `Quick wrap;
          Alcotest.test_case "large append exact suffix" `Quick large;
          Alcotest.test_case "tiny writes" `Quick tiny;
          Alcotest.test_case "one-shot replay boundary" `Quick replay;
          Alcotest.test_case "checked arithmetic and atomic refusal" `Quick
            arithmetic;
          Alcotest.test_case "legacy unchanged" `Quick legacy;
          Alcotest.test_case "birth completeness survives only until first trim"
            `Quick birth_history;
        ] );
    ]
