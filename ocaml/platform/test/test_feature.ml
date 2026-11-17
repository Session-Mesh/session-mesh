(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module P = Mesh_platform

let capabilities ~isolated_agent ~demo_sandbox : P.capabilities =
  {
    process_table = true;
    foreground_agent = true;
    open_file_paths = true;
    isolated_agent;
    demo_sandbox;
  }

let all_on = capabilities ~isolated_agent:true ~demo_sandbox:true
let isolated_off = capabilities ~isolated_agent:false ~demo_sandbox:true
let sandbox_off = capabilities ~isolated_agent:true ~demo_sandbox:false

let contains ~needle text =
  let needle_length = String.length needle in
  let text_length = String.length text in
  let rec at start =
    start + needle_length <= text_length
    && (String.sub text start needle_length = needle || at (start + 1))
  in
  at 0

let check_mentions what ~needle text =
  Alcotest.(check bool) (what ^ ": " ^ needle) true (contains ~needle text)

let refusal ~platform ~capabilities feature =
  match P.For_testing.require_on ~platform ~capabilities feature with
  | Ok () -> Alcotest.fail "expected a refusal"
  | Error message -> message

let test_available_is_ok () =
  Alcotest.(check bool)
    "isolated" true
    (P.require ~capabilities:all_on P.Isolated_agent = Ok ());
  Alcotest.(check bool)
    "sandbox" true
    (P.require ~capabilities:all_on P.Demo_sandbox = Ok ())

let test_only_the_missing_feature_is_refused () =
  Alcotest.(check bool)
    "sandbox still ok" true
    (P.require ~capabilities:isolated_off P.Demo_sandbox = Ok ());
  Alcotest.(check bool)
    "isolated still ok" true
    (P.require ~capabilities:sandbox_off P.Isolated_agent = Ok ())

(* On the machine running the tests, whatever the platform. *)
let test_refusal_on_current_platform () =
  let check feature capabilities words =
    match P.require ~capabilities feature with
    | Ok () -> Alcotest.fail "expected a refusal"
    | Error message ->
        check_mentions "feature" ~needle:words message;
        check_mentions "platform" ~needle:(P.platform_name P.platform) message;
        if P.platform = P.Linux then
          check_mentions "executable" ~needle:"/usr/bin/" message
  in
  check P.Isolated_agent isolated_off "isolated agent";
  check P.Demo_sandbox sandbox_off "demo compiler sandbox"

let test_linux_names_executable_and_package () =
  let isolated =
    refusal ~platform:P.Linux ~capabilities:isolated_off P.Isolated_agent
  in
  check_mentions "isolated" ~needle:"/usr/bin/setpriv" isolated;
  check_mentions "isolated" ~needle:"util-linux" isolated;
  check_mentions "isolated" ~needle:"on linux:" isolated;
  let sandbox =
    refusal ~platform:P.Linux ~capabilities:sandbox_off P.Demo_sandbox
  in
  check_mentions "sandbox" ~needle:"/usr/bin/bwrap" sandbox;
  check_mentions "sandbox" ~needle:"bubblewrap" sandbox

let test_other_platforms_say_linux_only () =
  List.iter
    (fun platform ->
      List.iter
        (fun (feature, capabilities, words) ->
          let message = refusal ~platform ~capabilities feature in
          check_mentions "platform" ~needle:(P.platform_name platform) message;
          check_mentions "feature" ~needle:words message;
          check_mentions "reason" ~needle:"Linux-only on this release" message)
        [
          (P.Isolated_agent, isolated_off, "isolated agent");
          (P.Demo_sandbox, sandbox_off, "demo compiler sandbox");
        ])
    [ P.Macos; P.Other "freebsd" ]

let test_message_is_one_sentence () =
  List.iter
    (fun platform ->
      let message =
        refusal ~platform ~capabilities:isolated_off P.Isolated_agent
      in
      Alcotest.(check bool) "no newline" false (String.contains message '\n'))
    [ P.Linux; P.Macos; P.Other "freebsd" ]

let test_name_round_trip () =
  List.iter
    (fun feature ->
      Alcotest.(check bool)
        "round trip" true
        (P.feature_of_string (P.feature_name feature) = Some feature))
    [ P.Isolated_agent; P.Demo_sandbox ];
  Alcotest.(check string)
    "isolated" "isolated-agent"
    (P.feature_name P.Isolated_agent);
  Alcotest.(check string)
    "sandbox" "demo-sandbox"
    (P.feature_name P.Demo_sandbox)

let test_unknown_name () =
  List.iter
    (fun text ->
      Alcotest.(check bool)
        ("unknown " ^ text) true
        (P.feature_of_string text = None))
    [ ""; "isolated_agent"; "Isolated-Agent"; "bwrap"; "demo-sandbox " ]

let tests =
  [
    Alcotest.test_case "available feature is Ok" `Quick test_available_is_ok;
    Alcotest.test_case "only the missing feature is refused" `Quick
      test_only_the_missing_feature_is_refused;
    Alcotest.test_case "refusal names feature and platform" `Quick
      test_refusal_on_current_platform;
    Alcotest.test_case "linux refusal names executable and package" `Quick
      test_linux_names_executable_and_package;
    Alcotest.test_case "other platforms say Linux-only" `Quick
      test_other_platforms_say_linux_only;
    Alcotest.test_case "refusal is one line" `Quick test_message_is_one_sentence;
    Alcotest.test_case "feature name round trip" `Quick test_name_round_trip;
    Alcotest.test_case "unknown feature name" `Quick test_unknown_name;
  ]
