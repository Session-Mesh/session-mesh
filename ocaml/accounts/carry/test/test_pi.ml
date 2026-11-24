(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Carry_fixture

module Pi = Mesh_accounts_carry__Carry_pi
module Write = Mesh_accounts_carry__Carry_write
module Base = Mesh_accounts_carry__Carry_base

let path = Filename.concat
let group = "--home-work--"
let filename = "2026-11-22T10-00-00_" ^ sid ^ ".jsonl"
let relative = group ^ "/" ^ filename

let header =
  Printf.sprintf
    {|{"type":"session","version":3,"id":"%s","timestamp":"2026-11-22T10:00:00.000Z","cwd":"/work"}|}
    sid

let lines =
  [
    header;
    {|{"type":"message","id":"a0000001","parentId":null,"timestamp":"2026-11-22T10:00:01.000Z","message":{"role":"system","content":"entire prompt","timestamp":1}}|};
    {|{"type":"message","id":"a0000002","parentId":"a0000001","timestamp":"2026-11-22T10:00:02.000Z","message":{"role":"user","content":"full original context","timestamp":2}}|};
    {|{"type":"message","id":"a0000003","parentId":"a0000002","timestamp":"2026-11-22T10:00:03.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"tc1","name":"read","arguments":{}}],"timestamp":3}}|};
    {|{"type":"message","id":"a0000004","parentId":"a0000003","timestamp":"2026-11-22T10:00:04.000Z","message":{"role":"toolResult","toolCallId":"tc1","toolName":"read","content":[{"type":"text","text":"tool bytes"}],"timestamp":4}}|};
    {|{"type":"message","id":"a0000005","parentId":"a0000002","timestamp":"2026-11-22T10:00:05.000Z","message":{"role":"user","content":"alternate branch","timestamp":5}}|};
    {|{"type":"branch_summary","id":"a0000006","parentId":"a0000004","fromId":"a0000005","summary":"branch retained","timestamp":"2026-11-22T10:00:06.000Z"}|};
    {|{"type":"compaction","id":"a0000007","parentId":"a0000006","firstKeptEntryId":"a0000004","summary":"compact view","tokensBefore":500,"timestamp":"2026-11-22T10:00:07.000Z"}|};
    {|{"type":"custom","id":"a0000008","parentId":"a0000007","customType":"example","data":{"full":"extension state"},"timestamp":"2026-11-22T10:00:08.000Z"}|};
    {|{"type":"custom_message","id":"a0000009","parentId":"a0000008","customType":"example","content":"injected context","timestamp":"2026-11-22T10:00:09.000Z"}|};
    {|{"type":"context_edit","id":"a000000a","parentId":"a0000009","targetId":"a0000002","replacement":null,"timestamp":"2026-11-22T10:00:10.000Z"}|};
    {|{"type":"label","id":"a000000b","parentId":"a000000a","targetId":"a0000004","label":"bookmark","timestamp":"2026-11-22T10:00:11.000Z"}|};
    {|{"type":"session_info","id":"a000000c","parentId":"a000000b","name":"Full session","timestamp":"2026-11-22T10:00:12.000Z"}|};
  ]

let session = String.concat "\n" lines ^ "\n"

let replace_one ~from ~into text =
  let rec find i =
    if i + String.length from > String.length text then
      Alcotest.failf "substring not found: %s" from
    else if String.sub text i (String.length from) = from then i
    else find (i + 1)
  in
  let i = find 0 in
  String.sub text 0 i ^ into ^
  String.sub text (i + String.length from)
    (String.length text - i - String.length from)

let with_pair test () =
  with_root (fun root ->
      let root = Unix.realpath root in
      let source = path root "source" and target = path root "target" in
      mkdirs source;
      mkdirs target;
      Unix.chmod root 0o700;
      write (path source relative) session;
      test root source target)

let call ?io ?limits source target =
  Pi.carry ?io ?limits ~uid ~source ~target ~conversation:sid ()

let expect_code code result =
  match result with
  | Ok _ -> Alcotest.failf "expected refusal %s" code
  | Error (error : Pi.error) ->
      Alcotest.(check string) "error code" code error.code;
      Alcotest.(check bool) "no absolute paths" false
        (contains error.message "/tmp/")

let bytes_only source target =
  Alcotest.(check string) "complete JSONL retained byte-for-byte"
    (read (path source relative)) (read (path target relative))

let test_full_context _ source target =
  write (path source (group ^ "/other.jsonl")) "unrelated";
  write (path source "settings.json") "private settings";
  let result = call source target in
  (match result with
  | Error error -> Alcotest.failf "%s: %s" error.code error.message
  | Ok outcome ->
      Alcotest.(check int) "one file" 1 outcome.files;
      Alcotest.(check int) "copied" 1 outcome.copied;
      Alcotest.(check int) "all bytes" (String.length session) outcome.bytes);
  bytes_only source target;
  Alcotest.(check bool) "other session excluded" false
    (exists (path target (group ^ "/other.jsonl")));
  Alcotest.(check bool) "settings excluded" false
    (exists (path target "settings.json"));
  Alcotest.(check bool) "no credentials" false
    (exists (path target "auth.json"))

let test_exact_and_unique _ source target =
  let other = "1f1e2d3c-4b5a-4968-8778-695a4b3c2d1e" in
  write (path source (group ^ "/2026-11-22T10-00-00_" ^ other ^ ".jsonl"))
    (replace_one ~from:sid ~into:other header ^ "\n");
  (match call source target with
  | Ok out -> Alcotest.(check int) "only exact ID" 1 out.copied
  | Error e -> Alcotest.failf "%s: %s" e.code e.message);
  write (path source ("--second--/" ^ filename)) session;
  expect_code "conversation_ambiguous" (call source target)

let test_no_exact_match _ source target =
  Unix.unlink (path source relative);
  write (path source (group ^ "/2026-11-22T10-00-00_other-" ^ sid ^ ".jsonl"))
    session;
  expect_code "conversation_not_found" (call source target);
  Alcotest.(check bool) "no target session" false
    (exists (path target relative))

let test_working_directory_with_spaces _ source target =
  let grouped = "--home-project with spaces--/" ^ filename in
  mkdirs (Filename.dirname (path source grouped));
  Unix.rename (path source relative) (path source grouped);
  (match call source target with
  | Ok out -> Alcotest.(check int) "session found" 1 out.copied
  | Error e -> Alcotest.failf "%s: %s" e.code e.message);
  Alcotest.(check string) "unmodified content" session
    (read (path target grouped))

let test_flat_and_grouped _ source target =
  Unix.rename (path source relative) (path source filename);
  (match call source target with
  | Ok out -> Alcotest.(check int) "flat session copied" 1 out.copied
  | Error e -> Alcotest.failf "%s: %s" e.code e.message);
  Alcotest.(check string) "flat session intact" session (read (path target filename));
  write (path source relative) session;
  expect_code "conversation_ambiguous" (call source target);
  Alcotest.(check bool) "grouped session not copied" false
    (exists (path target relative))

let test_other_path_refused _ source target =
  let other = "--other--/" ^ filename in
  let leftover =
    path target (group ^ "/." ^ filename ^ ".carry-old-0123456789abcdef")
  in
  write leftover "pending cleanup";
  write (path target other) session;
  expect_code "conversation_ambiguous" (call source target);
  Alcotest.(check bool) "source path not copied" false
    (exists (path target relative));
  Alcotest.(check string) "cleanup not started" "pending cleanup" (read leftover);
  Alcotest.(check string) "existing target retained" session
    (read (path target other));
  Unix.unlink (path target other);
  write (path target filename) session;
  expect_code "conversation_ambiguous" (call source target);
  Alcotest.(check bool) "flat target retained" true (exists (path target filename));
  Alcotest.(check bool) "grouped target not copied" false
    (exists (path target relative));
  Unix.unlink (path target filename);
  let later = group ^ "/2026-11-22T11-00-00_" ^ sid ^ ".jsonl" in
  write (path target later) session;
  expect_code "conversation_ambiguous" (call source target);
  Alcotest.(check bool) "different timestamp retained" true
    (exists (path target later))

let test_native_messages _ source target =
  let full_output = path source "not-present-output.txt" in
  let bash =
    Printf.sprintf
      {|{"type":"message","id":"a000000d","parentId":"a000000c","timestamp":"2026-11-22T10:00:13.000Z","message":{"role":"bashExecution","command":"printf 'data'","output":"data","exitCode":0,"cancelled":false,"truncated":true,"timestamp":13,"fullOutputPath":%s,"excludeFromContext":true}}|}
      (Yojson.Safe.to_string (`String full_output))
  in
  let custom =
    {|{"type":"custom","id":"a000000e","parentId":"a000000d","customType":"marker","timestamp":"2026-11-22T10:00:14.000Z"}|}
  in
  let whole = session ^ bash ^ "\n" ^ custom ^ "\n" in
  write (path source relative) whole;
  Alcotest.(check bool) "full output reference is absent" false
    (exists full_output);
  (match call source target with
  | Ok out -> Alcotest.(check int) "native messages copied" 1 out.copied
  | Error e -> Alcotest.failf "%s: %s" e.code e.message);
  Alcotest.(check string) "native payload retained as data" whole
    (read (path target relative));
  Alcotest.(check bool) "full output reference remains metadata" false
    (exists full_output);
  let cancelled =
    replace_one ~from:{|"exitCode":0,"cancelled":false|}
      ~into:{|"cancelled":true|} whole
  in
  Unix.unlink (path target relative);
  write (path source relative) cancelled;
  (match call source target with
  | Ok out -> Alcotest.(check int) "cancelled bash is valid" 1 out.copied
  | Error e -> Alcotest.failf "%s: %s" e.code e.message);
  Alcotest.(check string) "cancelled bash retained" cancelled
    (read (path target relative));
  let missing =
    replace_one ~from:{|"output":"data"|} ~into:{|"output":42|} whole
  in
  write (path source relative) missing;
  expect_code "conversation_invalid" (call source target);
  Alcotest.(check string) "valid target unaffected" cancelled
    (read (path target relative))

let test_fork_summary_and_context_edits _ source target =
  let fork = replace_one ~from:{|"fromId":"a0000005"|}
      ~into:{|"fromId":"deadbeef"|} session in
  let object_edit = replace_one ~from:{|"replacement":null|}
      ~into:{|"replacement":{"content":"edited"}|} fork in
  write (path source relative) object_edit;
  (match call source target with
   | Ok _ -> () | Error error -> Alcotest.failf "valid fork refused: %s" error.message);
  Alcotest.(check string) "valid fork copied" object_edit (read (path target relative));
  Unix.unlink (path target relative);
  List.iter (fun (label, text) ->
    write (path source relative) text;
    expect_code "conversation_invalid" (call source target);
    Alcotest.(check bool) label false (exists (path target relative))) [
      ("scalar edit rejected", replace_one ~from:{|"replacement":null|} ~into:{|"replacement":42|} session);
      ("missing content rejected", replace_one ~from:{|"replacement":null|} ~into:{|"replacement":{}|} session);
      ("invalid content rejected", replace_one ~from:{|"replacement":null|} ~into:{|"replacement":{"content":false}|} session);
      ("invalid name rejected", replace_one ~from:{|"name":"Full session"|} ~into:{|"name":42|} session);
      ("invalid fork origin rejected", replace_one ~from:{|"fromId":"a0000005"|} ~into:{|"fromId":"not valid"|} session)
    ]

let test_malformed _ source target =
  let original = read (path source relative) in
  List.iter
    (fun (name, text, code) ->
      write (path source relative) text;
      expect_code code (call source target);
      Alcotest.(check bool) name false (exists (path target relative)))
    [
      ("v2 unsupported", String.concat "\n"
          (replace_one ~from:"\"version\":3" ~into:"\"version\":2" header
          :: List.filteri (fun i _ -> i > 0) lines)
          ^ "\n", "conversation_unsupported");
      ("incomplete last line", String.sub original 0 (String.length original - 1),
       "conversation_invalid");
      ("non-JSON line", header ^ "\n{\n", "conversation_invalid");
      ("orphan parent",
       header ^ "\n" ^
       {|{"type":"message","id":"a0000001","parentId":"missing","timestamp":"2026-11-22T10:00:01.000Z","message":{"role":"user","content":"hi"}}|}
       ^ "\n", "conversation_invalid");
      ("duplicate entry", header ^ "\n" ^
       (match lines with _ :: entry :: _ -> entry | _ -> assert false) ^ "\n" ^
       (match lines with _ :: entry :: _ -> entry | _ -> assert false) ^ "\n",
       "conversation_invalid");
      ("unknown entry", header ^ "\n" ^
       {|{"type":"new_future_type","id":"a0000001","parentId":null,"timestamp":"2026-11-22T10:00:01.000Z"}|}
       ^ "\n", "conversation_unsupported");
      ("invalid entry id", header ^ "\n" ^
       {|{"type":"message","id":"broken id","parentId":null,"timestamp":"2026-11-22T10:00:01.000Z","message":{"role":"user","content":"hi"}}|}
       ^ "\n", "conversation_invalid");
      ("missing message content", header ^ "\n" ^
       {|{"type":"message","id":"a0000001","parentId":null,"timestamp":"2026-11-22T10:00:01.000Z","message":{"role":"user"}}|}
       ^ "\n", "conversation_invalid");
      ("invalid message content", header ^ "\n" ^
       {|{"type":"message","id":"a0000001","parentId":null,"timestamp":"2026-11-22T10:00:01.000Z","message":{"role":"user","content":42}}|}
       ^ "\n", "conversation_invalid");
      ("incomplete compaction", header ^ "\n" ^
       {|{"type":"message","id":"a0000001","parentId":null,"timestamp":"2026-11-22T10:00:01.000Z","message":{"role":"user","content":"hi"}}|}
       ^ "\n" ^
       {|{"type":"compaction","id":"a0000002","parentId":"a0000001","firstKeptEntryId":"a0000001","summary":"short","timestamp":"2026-11-22T10:00:02.000Z"}|}
       ^ "\n", "conversation_invalid");
    ];
  write (path source relative) original

let test_identity _ source target =
  let wrong = "1f1e2d3c-4b5a-4968-8778-695a4b3c2d1e" in
  write (path source relative)
    (replace_one ~from:sid ~into:wrong header ^ "\n");
  expect_code "conversation_invalid" (call source target);
  Alcotest.(check bool) "mismatched header not copied" false
    (exists (path target relative))

let test_links_and_overlap root source target =
  let original = path source relative in
  let moved = path source (group ^ "/real") in
  Unix.rename original moved;
  Unix.symlink moved original;
  expect_code "unsafe_entry" (call source target);
  Unix.unlink original;
  Unix.link moved original;
  expect_code "unsafe_entry" (call source target);
  Unix.unlink original;
  Unix.rename moved original;
  let dest = path target relative in
  mkdirs (Filename.dirname dest);
  Unix.symlink original dest;
  expect_code "unsafe_entry" (call source target);
  Unix.unlink dest;
  let outside = path root "other-hardlink" in
  write outside session;
  Unix.link outside dest;
  expect_code "unsafe_entry" (call source target);
  Unix.unlink dest;
  let nested = path source "nested" in
  mkdirs nested;
  expect_code "account_same" (call source nested)

let shared_io () : Write.io =
  let unexpected operation =
    Alcotest.failf "shared history attempted %s" operation
  in
  {
    read = Unix.read;
    write = (fun _ _ _ _ -> unexpected "write");
    unlink = (fun _ -> unexpected "unlink");
    rename = (fun _ _ -> unexpected "rename");
    rename_noreplace = (fun _ _ -> unexpected "rename_noreplace");
    link = (fun _ _ -> unexpected "link");
    close = Unix.close;
    free_bytes = (fun _ -> unexpected "free-space check");
  }

let test_shared_history _ source _ =
  let lock = path source C.lock_name in
  write lock "";
  let leftover =
    path source (group ^ "/." ^ filename ^ ".carry-new-0123456789abcdef")
  in
  write leftover "keep unfinished copy";
  let credential = path source "auth.json" in
  write credential "private";
  Unix.chmod credential 0o000;
  let before = listing source in
  let run target =
    match call ~io:(shared_io ()) source target with
    | Error error -> Alcotest.failf "%s: %s" error.code error.message
    | Ok out ->
        Alcotest.(check int) "one validated file" 1 out.files;
        Alcotest.(check int) "no copy" 0 out.copied;
        Alcotest.(check int) "no replacement" 0 out.replaced;
        Alcotest.(check int) "shared transcript unchanged" 1 out.unchanged;
        Alcotest.(check int) "zero payload bytes written" 0 out.bytes
  in
  run source;
  Alcotest.(check string) "complete session unchanged" session
    (read (path source relative));
  Alcotest.(check string) "leftover not cleaned" "keep unfinished copy"
    (read leftover);
  Alcotest.(check (list string)) "no history entries changed" before
    (listing source);
  Alcotest.(check int) "credential never opened" 0
    ((Unix.lstat credential).Unix.st_perm land 0o777)

let test_shared_invalid _ source _ =
  let original = path source relative in
  let run expected = expect_code expected (call ~io:(shared_io ()) source source) in
  write original (header ^ "\n{");
  run "conversation_invalid";
  write original
    (replace_one ~from:"\"version\":3" ~into:"\"version\":2" header
    ^ "\n" ^ List.nth lines 1 ^ "\n");
  run "conversation_unsupported";
  Unix.unlink original;
  let real = path source (group ^ "/actual-session") in
  write real session;
  Unix.symlink real original;
  run "unsafe_entry";
  Unix.unlink original;
  Unix.rename real original;
  write (path source ("--second--/" ^ filename)) session;
  run "conversation_ambiguous";
  Alcotest.(check string) "source file intact" session (read original)

let test_resume _ source target =
  let partial = String.concat "\n" (List.filteri (fun i _ -> i < 3) lines) ^ "\n" in
  write (path target relative) partial;
  (match call source target with
  | Ok out ->
      Alcotest.(check int) "extended prefix" 1 out.replaced;
      Alcotest.(check int) "remaining bytes counted" (String.length session) out.bytes
  | Error e -> Alcotest.failf "prefix refused: %s %s" e.code e.message);
  bytes_only source target;
  (match call source target with
  | Ok out ->
      Alcotest.(check int) "identical no-op" 1 out.unchanged;
      Alcotest.(check int) "nothing written" 0 out.bytes
  | Error e -> Alcotest.failf "identical refused: %s %s" e.code e.message);
  let different = header ^ "\n" ^
    {|{"type":"message","id":"a0000001","parentId":null,"timestamp":"2026-11-22T10:00:01.000Z","message":{"role":"user","content":"not the same"}}|}
    ^ "\n" in
  write (path target relative) different;
  expect_code "conversation_diverged" (call source target);
  Alcotest.(check string) "divergent target retained" different
    (read (path target relative));
  write (path target relative) (header ^ "\n{");
  expect_code "conversation_invalid" (call source target)

let injected (io : C.io) : Write.io =
  {
    write = io.write; read = io.read; unlink = io.unlink;
    rename = io.rename; rename_noreplace = io.rename_noreplace; link = io.link; close = io.close; free_bytes = io.free_bytes;
  }

let test_rollbacks _ source target =
  let io = injected (failing_io ~writes:0 ()) in
  expect_code "carry_rollback_incomplete" (call ~io source target);
  Alcotest.(check bool) "no partial output" false (exists (path target relative));
  Alcotest.(check bool) "no temporary" false
    (List.exists (fun p -> contains p ".carry-") (listing target));
  let io = injected (failing_io ~renames:0 ()) in
  expect_code "carry_failed" (call ~io source target);
  Alcotest.(check bool) "rename failure leaves no output" false
    (exists (path target relative));
  let io = injected (failing_io ~writes:0 ~unlinks:0 ()) in
  expect_code "carry_rollback_incomplete" (call ~io source target)

let test_replace_rollback _ source target =
  let partial = header ^ "\n" ^
    (match lines with _ :: first :: _ -> first | _ -> assert false) ^ "\n" in
  write (path target relative) partial;
  let io = injected (failing_io ~renames:0 ()) in
  expect_code "carry_restore_failed" (call ~io source target);
  Alcotest.(check string) "older valid prefix retained" partial
    (read (path target relative));
  Alcotest.(check bool) "backup retained for review" true
    (List.exists (fun p -> contains p ".carry-saved-") (listing target));
  expect_code "unsafe_entry" (call source target)

let test_no_space _ source target =
  let io = injected (failing_io ~free:(Some 0) ()) in
  expect_code "target_no_space" (call ~io source target);
  Alcotest.(check bool) "space refusal creates no file" false
    (exists (path target relative))

let test_bounds _ source target =
  expect_code "conversation_unknown"
    (Pi.carry ~uid ~source ~target ~conversation:"../bad" ());
  expect_code "conversation_too_large"
    (call ~limits:{ Base.default_limits with max_bytes = 10 } source target);
  expect_code "conversation_too_large"
    (call ~limits:{ Base.default_limits with max_files = 0 } source target);
  Alcotest.(check bool) "bounds refuse before copying" false
    (exists (path target relative))

let test_replaced_root _ source target =
  let moved = target ^ "-old" in
  let replacement = ref None in
  let io =
    {
      (failing_io ()) with
      C.free_bytes =
        (fun _ ->
          Unix.rename target moved;
          Unix.mkdir target 0o700;
          replacement := Some (Unix.lstat target);
          Some max_int);
    }
  in
  expect_code "account_folder_refused" (call ~io:(injected io) source target);
  (match !replacement with
  | None -> Alcotest.fail "did not reach free-space check"
  | Some before ->
      let after = Unix.lstat target in
      Alcotest.(check (pair int int)) "replacement identity retained"
        (before.Unix.st_dev, before.Unix.st_ino)
        (after.Unix.st_dev, after.Unix.st_ino));
  Alcotest.(check bool) "replacement untouched" false
    (exists (path target relative));
  Alcotest.(check bool) "original target not written" false
    (exists (path moved relative))

let test_same_size_source_change _ source target =
  let reads = ref 0 in
  let io =
    {
      (failing_io ()) with
      C.read =
        (fun fd bytes offset length ->
          incr reads;
          if !reads = 3 then
            write (path source relative)
              (String.concat "\n"
                 (List.map (fun l ->
                    if contains l "full original context" then
                      replace_one ~from:"full original context"
                        ~into:"lost original context" l
                    else l) lines) ^ "\n");
          Unix.read fd bytes offset length);
    }
  in
  expect_code "carry_rollback_incomplete" (call ~io:(injected io) source target);
  Alcotest.(check bool) "no changed source copied" false
    (exists (path target relative))

let test_staged_bytes_changed _ source target =
  let io =
    {
      (failing_io ()) with
      C.write =
        (fun fd bytes offset length ->
          let changed =
            replace_one ~from:"full original context"
              ~into:"lost original context"
              (Bytes.sub_string bytes offset length)
          in
          Unix.write_substring fd changed 0 (String.length changed));
    }
  in
  expect_code "carry_rollback_incomplete" (call ~io:(injected io) source target);
  Alcotest.(check bool) "staged corruption was not committed" false
    (exists (path target relative));
  Alcotest.(check bool) "staged file removed" false
    (List.exists (fun p -> contains p ".carry-new-") (listing target))

let test_old_cleanup_failure _ source target =
  write (path target relative) session;
  let leftover =
    path target
      (group ^ "/." ^ filename ^ ".carry-old-0123456789abcdef")
  in
  write leftover session;
  let attempted = ref false in
  let io =
    {
      (failing_io ()) with
      C.unlink =
        (fun name ->
          if name = leftover then (
            attempted := true;
            raise (Unix.Unix_error (Unix.EACCES, "unlink", "")))
          else Unix.unlink name);
    }
  in
  let result = call ~io:(injected io) source target in
  expect_code "carry_restore_failed" result;
  Alcotest.(check bool) "legacy backup is never unlinked" false !attempted;
  Alcotest.(check bool) "old copy retained for review" true (exists leftover);
  bytes_only source target;
  match result with
  | Error error ->
      Alcotest.(check bool) "remaining copy is named" true
        (contains error.message (Filename.basename leftover))
  | Ok _ -> Alcotest.fail "cleanup failure was reported as success"

let () =
  Alcotest.run "Pi v3 carry"
    [
      ("session", List.map
        (fun (name, test) -> Alcotest.test_case name `Quick (with_pair test))
        [
          ("whole tree and privacy", test_full_context);
          ("exact unique id", test_exact_and_unique);
          ("whole filename required", test_no_exact_match);
          ("working-directory group with spaces", test_working_directory_with_spaces);
          ("flat and grouped discovery", test_flat_and_grouped);
          ("target duplicate UUID across layouts", test_other_path_refused);
          ("native messages and optional custom data", test_native_messages);
          ("fork summaries and edits", test_fork_summary_and_context_edits);
          ("malformed and unsupported", test_malformed);
          ("header identity", test_identity);
          ("links and root overlap", test_links_and_overlap);
          ("shared physical history is validated without copying", test_shared_history);
          ("shared malformed symlink and duplicate IDs refuse", test_shared_invalid);
          ("valid prefix, identical and divergence", test_resume);
          ("write and rename rollback", test_rollbacks);
          ("replace rollback and retry", test_replace_rollback);
          ("disk space refusal", test_no_space);
          ("bounds and invalid IDs", test_bounds);
          ("replaced target root", test_replaced_root);
          ("same-size source changed during copy", test_same_size_source_change);
           ("staged bytes changed during copy", test_staged_bytes_changed);
           ("legacy old copy requires review", test_old_cleanup_failure);
        ]);
    ]
