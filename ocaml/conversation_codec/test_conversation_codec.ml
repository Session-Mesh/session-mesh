(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)

open Conversation_codec
open Conversation_registry_model

let decode ?(now = 100.) contents = Option.get (decode ~now contents)

let names entries = List.map (fun entry -> entry.incarnation.name) entries
let check_names = Alcotest.(check (list string))

let row name seen =
  Printf.sprintf {|{"name":%S,"created":0,"seen":%s}|} name seen

let raw_rows rows = "[" ^ String.concat "," rows ^ "]"

let text () =
  let special = " \tfi\nle\194\160\226\128\168\226\129\160x\226\128\174y\194\133\127z  " in
  Alcotest.(check string) "strip controls before collapsing whitespace"
    "file \226\129\160xyz" (normalize_text special);
  let emoji = "\240\159\144\136" in
  let repeated n = String.concat "" (List.init n (Fun.const emoji)) in
  Alcotest.(check string) "limit Unicode code points"
    (repeated 60) (normalize_text (repeated 61));
  Alcotest.(check string) "truncate after whitespace collapse"
    (String.make 59 'a' ^ " ") (normalize_text (String.make 59 'a' ^ " b"))

let fields () =
  let aliases =
    List.init 23 (fun i -> `String (string_of_int i)) @
    [`String " 4 "; `Bool false; `String ""]
  in
  let json =
    `Assoc ["name", `String "old"; "name", `String " current ";
            "created", `Int 3; "seen", `Float 10.; "aliases", `List aliases;
            "agent", `String "pi"; "sid", `String "Abc-def1"; "extra", `Bool false]
  in
  let entry = List.hd (decode (Yojson.Safe.to_string (`List [json]))) in
  Alcotest.(check string) "last occurrence wins" "current" entry.incarnation.name;
  Alcotest.(check (list string)) "deduplicate before cap"
    (List.init 20 (fun i -> string_of_int (i + 3))) entry.aliases;
  Alcotest.(check bool) "binding" true
    (entry.binding = Exact {agent = Pi; sid = "Abc-def1"});
  Alcotest.(check bool) "known fields only" true
    (entry_to_json entry = `Assoc
       ["name", `String "current"; "created", `Int 3; "seen", `Float 10.;
        "label", `String ""; "aliases", `List (List.map (fun a -> `String a) entry.aliases);
        "agent", `String "pi"; "sid", `String "Abc-def1"; "closed_at", `Null])

let invalid_fields () =
  let make fields = {|{"name":"invalid","created":1,"seen":1,|} ^ fields ^ "}" in
  let invalid =
    List.map make
      [ {|"created":true|}; {|"seen":NaN|}; {|"closed_at":Infinity|};
        {|"seen":1e900|}; {|"agent":"other"|}; {|"sid":"abcdefgh"|};
        {|"agent":"codex","sid":"-abcdefg"|};
        {|"agent":"codex","sid":"Abc def1"|}; {|"aliases":null|};
        {|"name":"\u001f "|} ]
  in
  check_names "bad records are independent" ["kept"]
    (names (decode (raw_rows (invalid @ [row "kept" "1"]))));
  List.iter
    (fun source ->
      Alcotest.(check bool) "unreadable input is distinct from an empty registry" true
        (Conversation_codec.decode ~now:100. source = None))
    ["{"; "{}"; raw_rows [row "a" "100"; "{\"name\":\"\255\"}"]];
  Alcotest.(check bool) "empty array is a valid registry" true
    (Conversation_codec.decode ~now:100. "[]" = Some [])

let retention () =
  let now = 7_776_100. in
  let rows =
    [row "boundary" "100"; row "future" "7776100.25"; row "retained" "100.5";
     row "tie-one" "7776100"; row "tie-two" "7776100.0"]
  in
  check_names "inclusive present, exclusive expiry, stable ties"
    ["tie-one"; "tie-two"; "retained"]
    (names (decode ~now (raw_rows rows)));
  let rows = List.init 1_000 (fun i -> row (string_of_int i) "100") in
  let expected = List.init 500 string_of_int in
  check_names "first thousand candidates, retained cap" expected
    (names (decode (raw_rows (rows @ [row "too-far" "100.25"]))));
  check_names "write caps independently of time or input candidate limits"
    expected (names (decode (encode (decode (raw_rows rows) @
                                    decode (raw_rows [row "extra" "100"])))))

let number_representations () =
  let document =
    {|[{"name":"archive","created":-315619200,"seen":100.0,"closed_at":99.125}]|}
  in
  let entries = decode document in
  (match Yojson.Safe.from_string (encode entries) with
  | `List [`Assoc fields] ->
      Alcotest.(check bool) "int and float timestamps keep their JSON representations" true
        (List.assoc "created" fields = `Int (-315619200)
         && List.assoc "closed_at" fields = `Float 99.125
         && List.assoc "seen" fields = `Float 100.)
  | _ -> Alcotest.fail "expected one object");
  let now = 0x1p53 in
  let rows = [row "float" "9007199254740992.0";
              row "below" "9007199254740991";
              row "above" "9007199254740993";
              row "equal" "9007199254740992"] in
  check_names "age uses float conversion, order uses integer precision"
    ["above"; "float"; "equal"; "below"] (names (decode ~now (raw_rows rows)))

let unicode_round_trip () =
  let document =
    {|[{"name":"Café","created":1,"seen":100,"label":"  Crème 🍐  ","aliases":["\u65e5\u672c","\ud83c\udf50"]}]|}
  in
  let entries = decode document in
  let entry = List.hd entries in
  Alcotest.(check string) "UTF-8 label" "Crème 🍐" entry.label;
  Alcotest.(check (list string)) "escaped Unicode aliases" ["日本"; "🍐"] entry.aliases;
  Alcotest.(check bool) "ordinary Unicode survives a write and reload" true
    (decode (encode entries) = entries)

let clock () =
  let called = ref 0 in
  let clock () = incr called; 100. in
  List.iter (fun contents -> ignore (decode_with_clock ~clock contents)) ["{"; "{}"];
  Alcotest.(check int) "parse failures and nonarrays do not sample the clock" 0 !called;
  check_names "clock result is used for filtering" ["kept"]
    (names (Option.get (decode_with_clock ~clock (raw_rows [row "kept" "100"; row "future" "101"]))));
  Alcotest.(check int) "sample once per parsed snapshot" 1 !called

let () =
  Alcotest.run "conversation codec"
    ["codec", List.map (fun (name, test) -> Alcotest.test_case name `Quick test)
       ["Unicode text", text; "fields", fields; "invalid fields", invalid_fields;
        "retention", retention; "number representations", number_representations;
        "Unicode round trip", unicode_round_trip; "clock", clock]]
