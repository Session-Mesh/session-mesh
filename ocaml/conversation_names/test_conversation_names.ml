(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

open Conversation_registry_model
open Mesh_conversation_names

let sid = "01900000-0000-0000-0000-000000000123"

let entry ?(name = "audit") ?(created = Int 1L) ?(seen = Int 1L)
    ?(label = "") ?(binding = Exact { agent = Codex; sid }) aliases =
  { incarnation = { name; created }; seen; label; aliases; binding; closed_at = None }

let history ?(agent = "codex") ?(id = sid) () : row =
  [ ("agent", `String agent); ("id", `String id); ("messages", `List []) ]

let session ?(created = `Int 1) () : row =
  [ ("name", `String "audit"); ("created", created); ("aliases", `Null) ]

let json_aliases aliases : Yojson.Safe.t =
  `List (List.map (fun alias -> `String alias) aliases)

let json = Alcotest.testable Yojson.Safe.pp Yojson.Safe.equal
let check_row message expected actual =
  Alcotest.check json message (`Assoc expected) (`Assoc actual)

let check_sessions message expected actual =
  let as_json rows = `List (List.map (fun row -> `Assoc row) rows) in
  Alcotest.check json message (as_json expected) (as_json actual)

let bounded_aliases () =
  let numbered i = Printf.sprintf "alias-%d" i in
  let entries =
    List.init 50 (fun i -> entry ~seen:(Int (Int64.of_int i)) [ numbered i ])
    |> List.rev
  in
  let newest = entry ~seen:(Int 50L) [ ""; numbered 0; numbered 40 ] in
  let entries = newest :: entries in
  let expected = List.init 20 (fun i -> numbered (i + 30)) in
  Alcotest.(check (list string)) "keep the last 20 first occurrences"
    expected (aliases entries);
  Alcotest.check json "history alias cap" (json_aliases expected)
    (List.assoc "mesh_aliases" (enrich (history ()) entries));
  match active_aliases entries [session ()] with
  | [row] ->
      Alcotest.check json "live alias cap" (json_aliases expected)
        (List.assoc "aliases" row)
  | _ -> Alcotest.fail "expected one live session"

let history_matches_exact_identity () =
  let item = history () in
  let entries =
    [ entry ~name:"newer" ~created:(Int 2L) ~seen:(Float 3.) ~label:"Newest"
        [ "alias-tie-first"; "shared" ];
      entry ~name:"tie" ~seen:(Int 3L) ~label:"Second tie"
        [ "shared"; "alias-tie-second" ];
      entry ~name:"old" ~seen:(Float 2.5) [ "old label" ];
      entry ~binding:(Exact { agent = Claude; sid }) ~seen:(Int 5L) [ "other agent" ];
      entry ~binding:(Exact { agent = Codex; sid = "abcdefgh-2222" }) ~seen:(Int 6L) [ "other conversation" ];
      entry ~binding:Unbound ~seen:(Int 7L) [ "unbound" ] ]
  in
  check_row "latest matching row and stable ties"
    (item @
       [ ("mesh_name", `String "newer"); ("mesh_label", `String "Newest");
         ("mesh_aliases",
          json_aliases [ "old label"; "alias-tie-first"; "shared"; "alias-tie-second" ]) ])
    (enrich item entries);
  let missing = history ~agent:"pi" () in
  check_row "unmatched detail retains its field set" missing (enrich missing entries)

let live_matches_incarnations () =
  let entries =
    [ entry ~seen:(Int 3L) ~binding:(Exact { agent = Codex; sid = "abcdefgh-2222" }) [ "current conversation" ];
      entry ~created:(Int 2L) ~seen:(Int 4L) [ "reused name" ];
      entry ~name:"other" ~seen:(Int 5L) [ "other session" ];
      entry ~created:(Float 1.) ~binding:Unbound [ "unbound label" ];
      entry ~seen:(Int 2L) [ "prior conversation" ] ]
  in
  let row created aliases : row =
    [ ("name", `String "audit"); ("created", created);
      ("aliases", json_aliases aliases) ]
  in
  check_sessions "session order, exact incarnation, and empty fallback"
    [ row (`Float 1.) [ "unbound label"; "prior conversation"; "current conversation" ];
      row (`Int 3) [];
      row (`Int 2) [ "reused name" ] ]
    (active_aliases entries
       [ session ~created:(`Float 1.) (); session ~created:(`Int 3) ();
         session ~created:(`Int 2) () ])

let preserves_existing_fields () =
  let detail =
    [ ("mesh_name", `Null); ("agent", `String "codex");
      ("mesh_aliases", `Null); ("id", `String sid) ]
  in
  check_row "overwrites fields in place and adds missing keys"
    [ ("mesh_name", `String "audit"); ("agent", `String "codex");
      ("mesh_aliases", json_aliases []); ("id", `String sid);
      ("mesh_label", `String "") ]
    (enrich detail [ entry [] ]);
  check_sessions "adds aliases when absent"
    [ [ ("name", `String "audit"); ("created", `Int 1); ("aliases", json_aliases []) ] ]
    (active_aliases [] [[ ("name", `String "audit"); ("created", `Int 1) ]])

let mixed_timestamps () =
  let beyond_max = 0x1p63 in
  let values =
    [ entry ~seen:(Float beyond_max) [ "outside signed 64-bit range" ];
      entry ~seen:(Float (-0.5)) [ "negative fractional time" ];
      entry ~seen:(Int Int64.max_int) [ "largest signed 64-bit integer" ];
      entry ~seen:(Int (-1L)) [ "negative integer time" ] ]
  in
  Alcotest.(check (list string)) "order mixed timestamps without int rounding"
    [ "negative integer time"; "negative fractional time";
      "largest signed 64-bit integer"; "outside signed 64-bit range" ]
    (aliases values);
  let intlit = `Intlit (Int64.to_string Int64.max_int) in
  check_sessions "distinct integer incarnation cannot match its rounded float"
    [ [ ("name", `String "audit"); ("created", `Float beyond_max);
        ("aliases", json_aliases [ "float" ]) ];
      [ ("name", `String "audit"); ("created", intlit);
        ("aliases", json_aliases [ "int" ]) ] ]
    (active_aliases
       [ entry ~created:(Int Int64.max_int) [ "int" ];
         entry ~created:(Float beyond_max) [ "float" ] ]
       [ session ~created:(`Float beyond_max) (); session ~created:intlit () ])

let () =
  Alcotest.run "conversation names"
    [ ("projection",
       [ Alcotest.test_case "bounded aliases" `Quick bounded_aliases;
         Alcotest.test_case "exact history identity" `Quick history_matches_exact_identity;
         Alcotest.test_case "live incarnation" `Quick live_matches_incarnations;
         Alcotest.test_case "existing fields" `Quick preserves_existing_fields;
         Alcotest.test_case "mixed timestamps" `Quick mixed_timestamps ]) ]
