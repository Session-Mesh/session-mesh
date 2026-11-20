(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Attempts in work-read: the summary of a task, the count of a list row, no
   warning noise, and a tracker with attempts still read by the worklog
   library (what an older build of work-read and wl's own format rely on). *)

open Work_read_runner
module U = Yojson.Safe.Util
module W = Mesh_worklog

let contains haystack needle =
  let n = String.length needle and m = String.length haystack in
  let rec at i = i + n <= m && (String.sub haystack i n = needle || at (i + 1)) in
  n = 0 || at 0

let ok repo args =
  let r = run repo args in
  if r.code <> 0 then Alcotest.failf "%s: exit %d: %s" (String.concat " " args) r.code r.out;
  json r

(* Three failures then nothing: the run reaches the threshold. Written as
   another host would write them, one with every optional field. *)
let attempt_lines =
  [
    {|{"ts":"2026-11-09T11:00:00Z","task":"T-1a2b","type":"attempt","id":"A-0000a001","outcome":"failure","reason":"ci_failure","text":"the delivery check is red in CI","links":["https://example.invalid/runs/1"],"started":"2026-11-09T10:00:00Z","ended":"2026-11-09T11:00:00Z","ref":"ship:1","agent":"claude","session":"s-ship"}|};
    {|{"ts":"2026-11-09T12:00:00Z","task":"T-1a2b","type":"attempt","id":"A-0000a002","outcome":"abandoned","agent":"claude","session":"s-ship"}|};
    {|{"ts":"2026-11-09T13:00:00Z","task":"T-1a2b","type":"attempt","id":"A-0000a003","outcome":"failure","reason":"test_red","agent":"claude","session":"s-ship"}|};
    {|{"ts":"2026-11-09T14:00:00Z","task":"T-1a2b","type":"attempt","id":"A-0000a004","outcome":"failure","reason":"review_nogo","text":"review NO-GO","agent":"claude","session":"s-ship"}|};
  ]

let with_attempts () =
  let repo = copy_fixture () in
  append_events repo attempt_lines;
  repo

(* The fixture has warnings of its own (malformed lines on purpose); none may
   be about an attempt. *)
let attempt_warning doc = contains (Yojson.Safe.to_string (U.member "data_warnings" doc)) "attempt"

let row id doc key = List.find (fun t -> U.to_string (U.member "id" t) = id) (U.to_list (U.member key doc))

let test_task_summary () =
  let doc = ok (with_attempts ()) [ "task"; "T-1a2b" ] in
  let a = U.member "attempts" doc in
  Alcotest.(check int) "total" 4 (U.to_int (U.member "total" a));
  Alcotest.(check int) "failures" 3 (U.to_int (U.member "failures" a));
  Alcotest.(check int) "an abandoned pass keeps the run" 3 (U.to_int (U.member "consecutive_failures" a));
  Alcotest.(check int) "threshold" 3 (U.to_int (U.member "consecutive_failures_threshold" a));
  Alcotest.(check bool) "flagged" true (U.to_bool (U.member "needs_reframe" a));
  let last = U.member "last" a in
  Alcotest.(check int) "derived number" 4 (U.to_int (U.member "n" last));
  Alcotest.(check string) "outcome" "failure" (U.to_string (U.member "outcome" last));
  Alcotest.(check string) "reason" "review_nogo" (U.to_string (U.member "reason" last));
  Alcotest.(check string) "at" "2026-11-09T14:00:00Z" (U.to_string (U.member "at" last));
  Alcotest.(check bool) "no attempt warning" false (attempt_warning doc);
  Alcotest.(check bool) "attempts stay out of the timeline" false
    (contains (Yojson.Safe.to_string (U.member "timeline" doc)) "\"attempt\"")

let test_rows () =
  let repo = with_attempts () in
  let project = ok repo [ "project"; "P-5e6f" ] in
  let shipped = row "T-1a2b" project "tasks" in
  Alcotest.(check int) "row count" 4 (U.to_int (U.member "attempts" shipped));
  Alcotest.(check int) "row run" 3 (U.to_int (U.member "consecutive_failures" shipped));
  Alcotest.(check bool) "a row without attempts is unchanged" true
    (U.member "attempts" (row "T-3c4d" project "tasks") = `Null);
  let resume = ok repo [ "resume" ] in
  Alcotest.(check int) "resume row" 4 (U.to_int (U.member "attempts" (row "T-1a2b" resume "in_progress")));
  List.iter
    (fun (what, doc) -> Alcotest.(check bool) (what ^ ": no attempt warning") false (attempt_warning doc))
    [ ("project", project); ("resume", resume); ("projects", ok repo [ "projects" ]) ]

let test_no_attempts () =
  let doc = ok (copy_fixture ()) [ "task"; "T-1a2b" ] in
  let a = U.member "attempts" doc in
  Alcotest.(check int) "zero" 0 (U.to_int (U.member "total" a));
  Alcotest.(check bool) "no last" true (U.member "last" a = `Null);
  Alcotest.(check bool) "not flagged" false (U.to_bool (U.member "needs_reframe" a))

let test_malformed_reported () =
  let repo = copy_fixture () in
  append_events repo
    [ {|{"ts":"2026-11-09T11:00:00Z","task":"T-1a2b","type":"attempt","id":"A-0000b001","outcome":"failure"}|} ];
  let doc = ok repo [ "task"; "T-1a2b" ] in
  Alcotest.(check int) "not counted" 0 (U.to_int (U.member "total" (U.member "attempts" doc)));
  Alcotest.(check bool) "reported" true
    (contains (Yojson.Safe.to_string (U.member "data_warnings" doc)) "attempt event ignored")

(* The library is the reader of every earlier build and has the format of
   wl: an attempt is an unknown type, reported, kept in the raw events and
   out of the fold; the lines on disk are never rewritten by a read. *)
let test_library_reads_attempts () =
  let repo = with_attempts () in
  let file = Filename.concat (Filename.concat repo.wl_home "events") "2026-11.hostc.jsonl" in
  let before = In_channel.with_open_bin file In_channel.input_all in
  let ctx = W.Ctx.make ~root:repo.wl_home ~host:"reader" ~commit:false () in
  let snap = W.Err.unwrap (W.Reader.snapshot ctx) in
  let unknown = List.filter (fun w -> contains w "unknown event type \"attempt\"") snap.warnings in
  Alcotest.(check int) "one warning per event" 4 (List.length unknown);
  Alcotest.(check int) "kept in the raw events" 4
    (List.length (List.filter (fun (e : W.Event.t) -> e.typ = "attempt") snap.loaded.events));
  Alcotest.(check bool) "the task still folds" true (W.Model.Smap.mem "T-1a2b" snap.loaded.world.tasks);
  ignore (ok repo [ "task"; "T-1a2b" ]);
  Alcotest.(check string) "lines preserved" before (In_channel.with_open_bin file In_channel.input_all)

let tests =
  [
    Alcotest.test_case "task summary" `Quick test_task_summary;
    Alcotest.test_case "list rows" `Quick test_rows;
    Alcotest.test_case "a task without attempts" `Quick test_no_attempts;
    Alcotest.test_case "malformed attempt reported" `Quick test_malformed_reported;
    Alcotest.test_case "the library reads a tracker with attempts" `Quick test_library_reads_attempts;
  ]
