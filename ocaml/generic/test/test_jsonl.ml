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


let scan ?(max_depth = 1) text =
  match Value.prescan ~max_depth text with
  | Ok () -> "ok"
  | Error Value.Too_deep -> "deep"
  | Error Value.Too_large -> "large"
  | Error (Value.Invalid _) -> "invalid"

let test_depth () =
  Alcotest.(check string) "flat" "ok" (scan {|{"a":1}|});
  Alcotest.(check string) "two levels" "deep" (scan {|{"a":[1]}|});
  Alcotest.(check string) "brackets in strings" "ok" (scan {|{"a":"[[[{{{\"[[["}|});
  let deep = String.make 200 '[' ^ String.make 200 ']' in
  let limits = { Value.default_limits with max_depth = 128 } in
  Alcotest.(check bool) "deep refused" true (Value.decode limits deep = Error Value.Too_deep);
  let ok = String.make 128 '[' ^ String.make 128 ']' in
  Alcotest.(check bool) "at the bound" true (Result.is_ok (Value.decode limits ok))

(* Yojson accepts comments; a quote inside one would hide every bracket after
   it from a scan that does not know about comments. *)
let test_comments () =
  let limits = { Value.default_limits with max_depth = 4 } in
  let invalid text = match Value.decode limits text with Error (Value.Invalid _) -> true | _ -> false in
  Alcotest.(check bool) "quote in a block comment" true (invalid {|/*"*/[[[[[[[[1]]]]]]]]|});
  Alcotest.(check bool) "block comment" true (invalid "/* c */ 1");
  Alcotest.(check bool) "line comment" true (invalid "1 // c");
  Alcotest.(check bool) "slash in a string" true
    (Value.decode limits {|{"path":"a/b","c":"/*"}|}
    = Ok (`Assoc [ ("path", `String "a/b"); ("c", `String "/*") ]))

let utf8 policy = { Value.default_limits with invalid_utf8 = policy }

let test_utf8_and_controls () =
  let invalid limits text = match Value.decode limits text with Error (Value.Invalid _) -> true | _ -> false in
  Alcotest.(check bool) "not UTF-8, rejected" true (invalid (utf8 Reject) "{\"a\":\"\xff\xfe\"}");
  Alcotest.(check bool) "not UTF-8, dropped" true
    (Value.decode (utf8 Drop) "{\"a\":\"x\xff\xe2\x82y\xe2\x82\xac\"}"
    = Ok (`Assoc [ ("a", `String "xy\xe2\x82\xac") ]));
  Alcotest.(check string) "maximal subparts" "Ax"
    (Value.drop_invalid_utf8 "\xe2A\xf0\x80\x80x\xed\xa0\x80");
  Alcotest.(check bool) "raw NUL in a string" true (invalid (utf8 Reject) "{\"a\":\"\000\"}");
  Alcotest.(check bool) "raw 0x01 in a string" true (invalid (utf8 Drop) "{\"a\":\"\001\"}");
  Alcotest.(check bool) "escaped control accepted" true
    (Value.decode (utf8 Reject) {|{"a":"\u0001"}|} = Ok (`Assoc [ ("a", `String "\001") ]))

let test_non_finite () =
  let limits = Value.default_limits in
  Alcotest.(check bool) "NaN decoded, as Python does" true
    (match Value.decode limits {|{"x":NaN}|} with Ok (`Assoc [ ("x", `Float f) ]) -> Float.is_nan f | _ -> false);
  let refused json = match Value.encode ~max_bytes:100 json with Error (Value.Invalid _) -> true | _ -> false in
  Alcotest.(check bool) "NaN not encoded" true (refused (`List [ `Float Float.nan ]));
  Alcotest.(check bool) "Infinity not encoded" true (refused (`Float Float.infinity));
  Alcotest.(check bool) "invalid UTF-8 not encoded" true (refused (`String "\xff"));
  Alcotest.(check bool) "newline in a literal not encoded" true (refused (`Intlit "1\n2"));
  Alcotest.(check (result string reject)) "controls escaped" (Ok {|"\u0001\u007f"|})
    (Result.map_error ignore (Value.encode ~max_bytes:100 (`String "\001\127")))

let json = Alcotest.testable Yojson.Safe.pp Yojson.Safe.equal

let test_decode () =
  let limits = { Value.max_bytes = 40; max_depth = 8; invalid_utf8 = Reject } in
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
          Alcotest.test_case "comments refused" `Quick test_comments;
          Alcotest.test_case "UTF-8 and control characters" `Quick test_utf8_and_controls;
          Alcotest.test_case "non-finite numbers" `Quick test_non_finite;
          Alcotest.test_case "decode and encode" `Quick test_decode;
        ] );
    ]
