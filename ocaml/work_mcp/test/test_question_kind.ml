(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The kind of a question (single, multi, text, yes_no): set by work_ask,
   stored on the question event only when given, read back as the effective
   kind (a question written before kinds existed, or with a kind this version
   does not know, reads as single with options and text without). The relayed
   path (work_answer) takes neither choices nor edit. *)

open Work_client
module W = Mesh_worklog
module Q = Work_mcp.Work_questions

let check_str msg expected actual = Alcotest.(check string) msg expected actual

let library_ctx wl_home =
  W.Ctx.make ~root:wl_home ~host:"owner-ui" ~commit:false ()

let options l = ("options", `List (List.map (fun o -> `String o) l))

let question_of c qid =
  List.find
    (fun q -> str q "id" = qid)
    (items (ok c "work_list_questions" (`Assoc [])) "questions")

let ask c args =
  str (ok c "work_ask" (`Assoc (("text", `String "Which?") :: args))) "id"

let question_events wl_home =
  List.filter
    (fun l -> contains l "\"type\":\"question\"")
    (event_lines wl_home)

let test_default_and_explicit () =
  with_server (fun c wl_home ->
      let plain = ask c [] in
      let listed = ask c [ options [ "REST"; "gRPC" ] ] in
      let multi =
        ask c [ options [ "a"; "b"; "c" ]; ("kind", `String "multi") ]
      in
      let yes_no = ask c [ ("kind", `String "yes_no") ] in
      let single = ask c [ options [ "x" ]; ("kind", `String "single") ] in
      let text = ask c [ ("kind", `String "text") ] in
      List.iter
        (fun (qid, kind) ->
          check_str (qid ^ " kind") kind (str (question_of c qid) "kind"))
        [
          (plain, "text");
          (listed, "single");
          (multi, "multi");
          (yes_no, "yes_no");
          (single, "single");
          (text, "text");
        ];
      (* Stored only when given: an old reader sees the same event as before. *)
      let stored =
        List.filter (fun l -> contains l "\"kind\"") (question_events wl_home)
      in
      Alcotest.(check int) "four events carry a kind" 4 (List.length stored);
      Alcotest.(check bool)
        "the default is not written" false
        (List.exists
           (fun l -> contains l plain && contains l "\"kind\"")
           (question_events wl_home)))

let test_invalid_kinds () =
  with_server (fun c wl_home ->
      let before = List.length (event_lines wl_home) in
      let refused what args =
        let r =
          call c "work_ask" (`Assoc (("text", `String "Which?") :: args))
        in
        Alcotest.(check bool) what true r.is_error
      in
      refused "an unknown kind" [ ("kind", `String "ranking") ];
      refused "a kind that is not a string" [ ("kind", `Int 1) ];
      refused "text with options" [ ("kind", `String "text"); options [ "a" ] ];
      refused "yes_no with options"
        [ ("kind", `String "yes_no"); options [ "yes"; "no" ] ];
      refused "multi without options" [ ("kind", `String "multi") ];
      refused "single without options" [ ("kind", `String "single") ];
      refused "nine options"
        [ ("kind", `String "multi"); options (List.init 9 string_of_int) ];
      refused "an option over 100 characters"
        [ ("kind", `String "multi"); options [ String.make 101 'o' ] ];
      refused "two equal options"
        [ ("kind", `String "multi"); options [ "a"; "a" ] ];
      Alcotest.(check int)
        "nothing written" before
        (List.length (event_lines wl_home));
      (* The library checks the kind again, for a writer that does not go
         through the tool's schema. *)
      let library =
        match Q.ask (library_ctx wl_home) ~text:"q" ~kind:"ranking" () with
        | Error _ -> true
        | Ok _ -> false
      in
      Alcotest.(check bool) "the library refuses an unknown kind" true library)

(* A kind written by a later version, or a kind that does not fit the options,
   reads as the default of its options. *)
let test_unknown_stored_kind () =
  with_server (fun c wl_home ->
      let seed id extra =
        W.Err.unwrap
          (W.Txn.run (library_ctx wl_home) (fun tx ->
               W.Txn.append tx
                 [
                   ( id,
                     "question",
                     [ ("id", `String id); ("text", `String "Seeded?") ] @ extra
                   );
                 ]))
      in
      seed "N-0000c001" [ ("kind", `String "ranking"); options [ "a"; "b" ] ];
      seed "N-0000c002" [ ("kind", `String "ranking") ];
      seed "N-0000c003" [ ("kind", `String "multi") ];
      seed "N-0000c004" [ ("kind", `Int 3); options [ "a" ] ];
      seed "N-0000c005" [ ("kind", `String "yes_no") ];
      (* text and yes_no take no options: with some, they do not fit. *)
      seed "N-0000c006" [ ("kind", `String "text"); options [ "a"; "b" ] ];
      seed "N-0000c007" [ ("kind", `String "yes_no"); options [ "a" ] ];
      List.iter
        (fun (qid, kind) ->
          check_str (qid ^ " reads as") kind (str (question_of c qid) "kind"))
        [
          ("N-0000c001", "single");
          ("N-0000c002", "text");
          ("N-0000c003", "text");
          ("N-0000c004", "single");
          ("N-0000c005", "yes_no");
          ("N-0000c006", "single");
          ("N-0000c007", "single");
        ])

let test_tool_schema () =
  let home, wl_home = fresh () in
  let c = connect ~wl_home ~home () in
  let tools =
    items (member "result" (rpc c "tools/list" (`Assoc []))) "tools"
  in
  let tool name = List.find (fun t -> str t "name" = name) tools in
  let ask_tool = tool "work_ask" in
  let kind =
    member "kind" (member "properties" (member "inputSchema" ask_tool))
  in
  Alcotest.(check (list string))
    "the kinds"
    [ "single"; "multi"; "text"; "yes_no" ]
    (List.map (function `String s -> s | _ -> "") (items kind "enum"));
  Alcotest.(check bool)
    "the description explains kind" true
    (contains (str ask_tool "description") "kind"
    && contains (str ask_tool "description") "multi");
  let answer_props =
    member "properties" (member "inputSchema" (tool "work_answer"))
  in
  Alcotest.(check bool)
    "work_answer takes no choices" true
    (member "choices" answer_props = `Null);
  Alcotest.(check bool)
    "work_answer takes no edit" true
    (member "edit" answer_props = `Null);
  stop c

(* The relayed path keeps its rule: one answer per question, never one that
   replaces an owner-verified answer, and no edit or choices argument. *)
let test_relay_cannot_edit () =
  with_server (fun c wl_home ->
      let qid = ask c [ options [ "a"; "b" ] ] in
      let refused what extra =
        let r =
          call c "work_answer"
            (`Assoc
               ([ ("question", `String qid); ("text", `String "a") ] @ extra))
        in
        Alcotest.(check bool) what true r.is_error
      in
      refused "edit is not a relay argument" [ ("edit", `Bool true) ];
      refused "choices are not a relay argument"
        [ ("choices", `List [ `String "a" ]) ];
      (* The library refuses them too off the owner-authenticated path. *)
      let library_refuses ?edit ?choices () =
        match
          Q.answer_once (library_ctx wl_home) ?edit ?choices ~question:qid
            ~text:"a" ~by:"owner" ()
        with
        | Error { kind = W.Err.Usage; _ } -> true
        | _ -> false
      in
      Alcotest.(check bool)
        "a relayed edit is refused" true
        (library_refuses ~edit:true ());
      Alcotest.(check bool)
        "relayed choices are refused" true
        (library_refuses ~choices:[ "a" ] ());
      Alcotest.(check int)
        "nothing written" 0
        (List.length (items (question_of c qid) "answers"));
      ignore
        (W.Err.unwrap
           (Q.answer_once (library_ctx wl_home) ~owner_web:true ~question:qid
              ~text:"a" ~by:Q.owner_by ()));
      let r =
        call c "work_answer"
          (`Assoc [ ("question", `String qid); ("text", `String "b") ])
      in
      check_str "the owner's answer stays" "already_answered" (error_code r);
      let q = question_of c qid in
      Alcotest.(check int) "one answer" 1 (List.length (items q "answers")))

let tests =
  [
    Alcotest.test_case "default and explicit kinds" `Quick
      test_default_and_explicit;
    Alcotest.test_case "invalid kinds are refused" `Quick test_invalid_kinds;
    Alcotest.test_case "unknown stored kinds fall back" `Quick
      test_unknown_stored_kind;
    Alcotest.test_case "work_ask schema has kind" `Quick test_tool_schema;
    Alcotest.test_case "the relay cannot edit" `Quick test_relay_cannot_edit;
  ]
