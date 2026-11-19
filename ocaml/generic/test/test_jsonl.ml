(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Lines = Mesh_jsonl_lines
module Value = Mesh_jsonl_value

let show = function Lines.Line text -> "line:" ^ text | Lines.Too_long -> "too-long"

(* Feed [text] cut at [cuts] (offsets) and collect what comes out. *)
let split ?start ~max_line_bytes ~cuts text =
  let splitter = Lines.create ?start ~max_line_bytes () in
  let out = ref [] in
  let emit line = out := show line :: !out in
  let rec go from = function
    | [] -> Lines.feed_string splitter (String.sub text from (String.length text - from)) emit
    | cut :: rest ->
        let cut = max from (min cut (String.length text)) in
        Lines.feed_string splitter (String.sub text from (cut - from)) emit;
        go cut rest
  in
  go 0 cuts;
  (List.rev !out, splitter)

let lines = Alcotest.(list string)

let test_split () =
  let out, splitter = split ~max_line_bytes:10 ~cuts:[ 1; 5 ] "ab\ncd\n\nef" in
  Alcotest.check lines "lines" [ "line:ab"; "line:cd"; "line:" ] out;
  Alcotest.(check int) "consumed" 7 (Lines.consumed splitter);
  Alcotest.(check int) "pending" 2 (Lines.pending_bytes splitter);
  Alcotest.(check (pair int bool)) "resume at the partial line" (7, true)
    (let offset, start = Lines.resume splitter in
     (offset, start = Lines.At_line_start))

let test_too_long () =
  let out, splitter = split ~max_line_bytes:3 ~cuts:[ 2; 4 ] "abcd\nxyz\nlonger" in
  Alcotest.check lines "dropped, then kept" [ "too-long"; "line:xyz" ] out;
  let offset, start = Lines.resume splitter in
  Alcotest.(check int) "resume after every byte of the dropped line" 15 offset;
  Alcotest.(check bool) "inside a long line" true (start = Lines.Inside_long_line);
  let out, _ = split ~start:Lines.Inside_long_line ~max_line_bytes:3 ~cuts:[] "tail\nok\n" in
  Alcotest.check lines "resumed long line is reported once" [ "too-long"; "line:ok" ] out

let test_skip_first () =
  let out, _ = split ~start:Lines.Skip_first_line ~max_line_bytes:100 ~cuts:[ 3 ] "partial\na\nb\n" in
  Alcotest.check lines "first line dropped silently" [ "line:a"; "line:b" ] out;
  let out, splitter = split ~start:Lines.Skip_first_line ~max_line_bytes:100 ~cuts:[] "no newline" in
  Alcotest.check lines "nothing yet" [] out;
  Alcotest.(check bool) "still skipping" true (snd (Lines.resume splitter) = Lines.Skip_first_line)

let test_chunking_property () =
  let arbitrary =
    QCheck.make
      ~print:(fun (text, cuts) ->
        Printf.sprintf "%S cut at %s" text (String.concat "," (List.map string_of_int cuts)))
      QCheck.Gen.(
        pair
          (string_size ~gen:(oneof_list [ 'a'; 'b'; '\n'; '{' ]) (int_bound 80))
          (list_size (int_bound 10) (int_bound 80)))
  in
  Support.qcheck ~name:"any chunking gives the same lines" arbitrary (fun (text, cuts) ->
      let cuts = List.sort compare cuts in
      let whole, whole_splitter = split ~max_line_bytes:5 ~cuts:[] text in
      let pieces, splitter = split ~max_line_bytes:5 ~cuts text in
      whole = pieces && Lines.resume whole_splitter = Lines.resume splitter)

let test_depth () =
  Alcotest.(check bool) "flat" true (Value.depth_within ~max_depth:1 {|{"a":1}|});
  Alcotest.(check bool) "two levels" false (Value.depth_within ~max_depth:1 {|{"a":[1]}|});
  Alcotest.(check bool) "brackets in strings" true
    (Value.depth_within ~max_depth:1 {|{"a":"[[[{{{\"[[["}|});
  let deep = String.make 200 '[' ^ String.make 200 ']' in
  let limits = { Value.default_limits with max_depth = 128 } in
  Alcotest.(check bool) "deep refused" true (Value.decode limits deep = Error Value.Too_deep);
  let ok = String.make 128 '[' ^ String.make 128 ']' in
  Alcotest.(check bool) "at the bound" true (Result.is_ok (Value.decode limits ok))

let json = Alcotest.testable Yojson.Safe.pp Yojson.Safe.equal

let test_decode () =
  let limits = { Value.max_bytes = 40; max_depth = 8 } in
  Alcotest.(check (result json reject))
    "last duplicate wins, at the first place"
    (Ok (`Assoc [ ("a", `Int 3); ("b", `Assoc [ ("c", `Int 2) ]) ]))
    (Result.map_error ignore
       (Value.decode limits {|{"a":1,"b":{"c":1,"c":2},"a":3}|}));
  Alcotest.(check bool) "too large" true
    (Value.decode limits (String.make 41 ' ') = Error Value.Too_large);
  let invalid text = match Value.decode limits text with Error (Value.Invalid _) -> true | _ -> false in
  Alcotest.(check bool) "garbage" true (invalid "{nope");
  Alcotest.(check bool) "junk after" true (invalid "1 2");
  Alcotest.(check bool) "blank" true (invalid "  ");
  Alcotest.(check bool) "encode bound" true
    (Value.encode ~max_bytes:5 (`String "abcdef") = Error Value.Too_large);
  Alcotest.(check (result string reject)) "encode" (Ok {|"a\nb"|})
    (Result.map_error ignore (Value.encode ~max_bytes:10 (`String "a\nb")))

let () =
  Alcotest.run "mesh_jsonl"
    [
      ( "lines",
        [
          Alcotest.test_case "split" `Quick test_split;
          Alcotest.test_case "too long" `Quick test_too_long;
          Alcotest.test_case "skip first line" `Quick test_skip_first;
          Alcotest.test_case "chunking (property)" `Quick test_chunking_property;
        ] );
      ( "value",
        [
          Alcotest.test_case "depth pre-scan" `Quick test_depth;
          Alcotest.test_case "decode and encode" `Quick test_decode;
        ] );
    ]
