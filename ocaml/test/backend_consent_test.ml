(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

module C = Mesh_backend_consent

let value = function Ok v -> v | Error e -> Alcotest.fail (C.error_code e)
let account = C.account ~backend:Mesh_backend_profile.Pi
let a = value (account ~id:"work" ~context_revision:(String.make 64 'a'))
let b = value (account ~id:"personal" ~context_revision:(String.make 64 'b'))
let c = value (account ~id:"limited" ~context_revision:(String.make 64 'c'))

let decide state source target =
  (value (C.decide state ~source ~target)).C.confirmation

let check expected actual =
  Alcotest.(check bool) "confirmation" true (expected = actual)

let once () =
  let empty = C.empty () in
  check C.Ask (decide empty a b);
  let next =
    value
      (C.commit_choice empty ~expected_revision:0 ~source:a ~target:b C.Once)
  in
  Alcotest.(check int) "once is not remembered" 0 (C.revision next);
  check C.Ask (decide next a b)

let pair () =
  let state =
    value
      (C.commit_choice (C.empty ()) ~expected_revision:0 ~source:a ~target:b
         C.Remember_pair)
  in
  check C.Skip (decide state a b);
  check C.Skip (decide state b a);
  check C.Ask (decide state a c)

let global_and_exception () =
  let global =
    value
      (C.commit_choice (C.empty ()) ~expected_revision:0 ~source:a ~target:b
         C.Remember_global)
  in
  check C.Skip (decide global b c);
  let state =
    value
      (C.set_pair global ~expected_revision:1 ~source:a ~target:c
         ~confirmation:C.Ask)
  in
  check C.Ask (decide state c a);
  check C.Skip (decide state a b);
  let state =
    value (C.remove_pair state ~expected_revision:2 ~source:a ~target:c)
  in
  check C.Skip (decide state a c);
  let state = value (C.reset state ~expected_revision:3) in
  check C.Ask (decide state a b);
  Alcotest.(check int) "revision advances" 4 (C.revision state)

let changed_context () =
  let state =
    value
      (C.set_pair (C.empty ()) ~expected_revision:0 ~source:a ~target:b
         ~confirmation:C.Skip)
  in
  let changed =
    value (account ~id:"personal" ~context_revision:(String.make 64 'd'))
  in
  check C.Ask (decide state a changed);
  let state =
    value
      (C.set_pair state ~expected_revision:1 ~source:a ~target:b
         ~confirmation:C.Ask)
  in
  check C.Ask (decide state a changed)

let conflicts () =
  let state =
    value (C.set_global (C.empty ()) ~expected_revision:0 ~confirmation:C.Skip)
  in
  Alcotest.(check bool)
    "stale management" true
    (Result.is_error (C.reset state ~expected_revision:0));
  Alcotest.(check bool)
    "stale staged choice" true
    (Result.is_error
       (C.commit_choice state ~expected_revision:0 ~source:a ~target:b
          C.Remember_pair));
  Alcotest.(check bool)
    "same account refused" true
    (Result.is_error (C.decide state ~source:a ~target:a));
  let reset = value (C.reset (C.empty ()) ~expected_revision:0) in
  Alcotest.(check int)
    "even reset invalidates pending intents" 1 (C.revision reset)

let codec () =
  let state =
    value
      (C.set_pair (C.empty ()) ~expected_revision:0 ~source:b ~target:a
         ~confirmation:C.Skip)
  in
  let restored = value (C.of_string (C.to_string state)) in
  check C.Skip (decide restored a b);
  let reject text =
    Alcotest.(check bool)
      "policy rejected" true
      (Result.is_error (C.of_string text))
  in
  List.iter reject
    [
      "{}";
      "{\"version\":1,\"revision\":-1,\"global\":\"ask\",\"pairs\":[]}";
      "{\"version\":1,\"revision\":0,\"global\":\"skip\",\"pairs\":[],\"token\":\"secret\"}";
      "{\"version\":1,\"revision\":0,\"revision\":0,\"global\":\"ask\",\"pairs\":[]}";
      "{\"version\":1,\"revision\":1.0,\"global\":\"ask\",\"pairs\":[]}";
    ];
  let exhausted =
    value
      (C.of_string
         "{\"version\":1,\"revision\":9007199254740991,\"global\":\"ask\",\"pairs\":[]}")
  in
  Alcotest.(check bool)
    "revision exhaustion" true
    (Result.is_error (C.reset exhausted ~expected_revision:9007199254740991))

let accounts () =
  List.iter
    (fun (id, revision) ->
      Alcotest.(check bool)
        "bad account" true
        (Result.is_error (account ~id ~context_revision:revision)))
    [
      ("", String.make 64 'a');
      ("a/b", String.make 64 'a');
      ("a", "short");
      ("a", String.make 64 'G');
    ]

let duplicate_and_capacity () =
  let state =
    value
      (C.set_pair (C.empty ()) ~expected_revision:0 ~source:a ~target:b
         ~confirmation:C.Skip)
  in
  let raw = Yojson.Safe.from_string (C.to_string state) in
  let duplicated =
    match raw with
    | `Assoc fields -> (
        match List.assoc_opt "pairs" fields with
        | Some (`List [ rule ]) ->
            `Assoc
              (("pairs", `List [ rule; rule ])
              :: List.remove_assoc "pairs" fields)
        | _ -> Alcotest.fail "pair expected")
    | _ -> Alcotest.fail "object expected"
  in
  Alcotest.(check bool)
    "duplicate pair refused" true
    (Result.is_error (C.of_string (Yojson.Safe.to_string duplicated)));
  let full =
    List.fold_left
      (fun state i ->
        let target =
          value
            (account
               ~id:("p" ^ string_of_int i)
               ~context_revision:(String.make 64 'a'))
        in
        value
          (C.set_pair state ~expected_revision:(C.revision state) ~source:a
             ~target ~confirmation:C.Skip))
      (C.empty ()) (List.init 1024 Fun.id)
  in
  let extra =
    value (account ~id:"overflow" ~context_revision:(String.make 64 'b'))
  in
  Alcotest.(check bool)
    "bounded rules" true
    (C.set_pair full ~expected_revision:1024 ~source:a ~target:extra
       ~confirmation:C.Skip
    = Error C.Capacity);
  let existing =
    value (account ~id:"p0" ~context_revision:(String.make 64 'a'))
  in
  ignore
    (value
       (C.set_pair full ~expected_revision:1024 ~source:a ~target:existing
          ~confirmation:C.Ask))

let backend_identity () =
  let other id =
    value
      (C.account ~backend:Mesh_backend_profile.Claude ~id
         ~context_revision:(String.make 64 'a'))
  in
  let state =
    value
      (C.set_pair (C.empty ()) ~expected_revision:0 ~source:a ~target:b
         ~confirmation:C.Skip)
  in
  check C.Ask (decide state (other "work") (other "personal"));
  Alcotest.(check bool)
    "cross-backend pair forbidden" true
    (C.decide state ~source:a ~target:(other "personal") = Error C.Invalid_pair);
  let state =
    value
      (C.remove_pair_ids state ~expected_revision:1
         ~backend:Mesh_backend_profile.Claude ~source_id:"work"
         ~target_id:"personal")
  in
  check C.Skip (decide state a b);
  let state = value (C.of_string (C.to_string state)) in
  check C.Skip (decide state a b);
  check C.Ask (decide state (other "work") (other "personal"))

let () =
  Alcotest.run "backend consent"
    [
      ( "policy",
        [
          Alcotest.test_case "once only" `Quick once;
          Alcotest.test_case "unordered exact pair" `Quick pair;
          Alcotest.test_case "global and restrictive exception" `Quick
            global_and_exception;
          Alcotest.test_case "context identity change" `Quick changed_context;
          Alcotest.test_case "CAS and same-account refusal" `Quick conflicts;
          Alcotest.test_case "strict codec and exhaustion" `Quick codec;
          Alcotest.test_case "validated references" `Quick accounts;
          Alcotest.test_case "backend-qualified pair identity" `Quick
            backend_identity;
          Alcotest.test_case "duplicates and finite capacity" `Quick
            duplicate_and_capacity;
        ] );
    ]
