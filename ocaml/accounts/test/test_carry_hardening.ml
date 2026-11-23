(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Follow-ups of the second review of a carry: files other users can write,
   the Codex folder layout, the lock key of case variants, an older copy kept
   until a carry succeeds, failed reads and removals reported, a source that
   changes during the copy, and a missing source that creates no target
   folder. *)

open Carry_fixture

let chmod folder relative mode =
  Unix.chmod (Filename.concat folder relative) mode

(* A file of the conversation that group or others can write is refused. *)
let test_writable_source_files () =
  with_root (fun root ->
      List.iteri
        (fun index (relative, mode) ->
          let source = claude_account root (Printf.sprintf "s%d" index) in
          let target = claude_account root (Printf.sprintf "t%d" index) in
          with_conversation source;
          chmod source relative mode;
          refused_with "unsafe_entry" (carry ~source ~target C.Claude);
          Alcotest.(check bool)
            "nothing written" false
            (exists (Filename.concat target "projects")))
        [ (own ^ "/tool-results/r1.txt", 0o664); (transcript, 0o602) ])

(* An older copy in the target that group or others can write is not
   replaced. *)
let test_writable_target_file () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      write (Filename.concat target transcript) "{\"line\":1}\n";
      chmod target transcript 0o660;
      refused_with "unsafe_entry" (carry ~source ~target C.Claude);
      Alcotest.(check string)
        "kept" "{\"line\":1}\n"
        (read (Filename.concat target transcript)))

(* A rollout outside sessions/YYYY/MM/DD is not the conversation's. *)
let test_codex_layout () =
  with_root (fun root ->
      let source = Filename.concat root "a" in
      let target = Filename.concat root "b" in
      mkdirs target;
      let misplaced =
        "sessions/cache/cached/misc/rollout-2026-11-20T10-00-00-" ^ sid
        ^ ".jsonl"
      in
      write (Filename.concat source misplaced) "{}\n";
      refused_with "conversation_not_found" (carry ~source ~target C.Codex);
      write (Filename.concat source rollout) "{}\n";
      let outcome = carried (carry ~source ~target C.Codex) in
      Alcotest.(check int) "only the rollout in place" 1 outcome.C.files;
      Alcotest.(check bool)
        "the misplaced one is not carried" false
        (exists (Filename.concat target misplaced)))

(* Two spellings of one id take the same lock: on a case-insensitive file
   system they name the same transcript. *)
let test_lock_ignores_case () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      let second = ref None in
      let status =
        while_carrying ~source ~target (fun () ->
            second :=
              Some
                (carry
                   ~conversation:(String.uppercase_ascii sid)
                   ~source ~target C.Claude))
      in
      Alcotest.(check bool) "the first completed" true (status = Unix.WEXITED 0);
      match !second with
      | Some refusal -> refused_with "carry_in_progress" refusal
      | None -> Alcotest.fail "the second carry did not run")

(* An older copy left by a failed carry stays until a carry succeeds. *)
let test_older_copy_kept_until_success () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      ignore (carried (carry ~source ~target C.Claude));
      let old = project ^ "/." ^ sid ^ ".jsonl.carry-old-0123456789abcdef" in
      write (Filename.concat target old) "{\"line\":1}\n";
      let diverged = Filename.concat target (own ^ "/tool-results/r1.txt") in
      write diverged "other";
      refused_with "conversation_diverged" (carry ~source ~target C.Claude);
      Alcotest.(check bool)
        "kept after a refusal" true
        (exists (Filename.concat target old));
      Unix.unlink diverged;
      ignore (carried (carry ~source ~target C.Claude));
      Alcotest.(check bool)
        "removed after a carry" false
        (exists (Filename.concat target old)))

(* A read that fails while comparing with an older copy is a refusal, not an
   exception. *)
let test_failed_read_is_refused () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      write (Filename.concat target transcript) "{\"line\":1}\n";
      let before = listing target in
      refused_with "carry_failed"
        (carry ~io:(failing_io ~reads:0 ()) ~source ~target C.Claude);
      Alcotest.(check (list string)) "as before" before (listing target))

(* A source that ends before its planned size while it is copied (here every
   read finds the end) is refused, and nothing is put in place. *)
let test_source_changed_during_copy () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      let before = listing target in
      let io = { (failing_io ()) with C.read = (fun _ _ _ _ -> 0) } in
      refused_with "carry_rollback_incomplete" (carry ~io ~source ~target C.Claude);
      let after = listing target in
      List.iter
        (fun relative ->
          Alcotest.(check bool) "older entry retained" true
            (List.mem relative after))
        before;
      Alcotest.(check bool) "no staged copy" false
        (List.exists (fun relative -> contains relative ".carry-new-") after))

(* A copy the rollback cannot remove is reported by name. *)
let test_incomplete_rollback_is_reported () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      let refusal =
        carry ~io:(failing_io ~renames:1 ~unlinks:0 ()) ~source ~target C.Claude
      in
      refused_with "carry_rollback_incomplete" refusal;
      let message = message_of refusal in
      Alcotest.(check bool) "names the copy" true (contains message transcript);
      Alcotest.(check bool) "no absolute path" false (contains message root);
      let again = carried (carry ~source ~target C.Claude) in
      Alcotest.(check int) "the next carry completes" 3 again.C.files)

(* A source account folder that does not exist creates no target folder. *)
let test_missing_source_creates_nothing () =
  with_root (fun root ->
      let travel = Filename.concat root "travel" in
      let file = Filename.concat root "accounts.json" in
      write file
        (Printf.sprintf
           {|{"v": 1, "accounts": [{"id": "travel", "label": "Travel", "claude_config_dir": "%s"}]}|}
           travel);
      refused_with "account_folder_refused"
        (C.carry_accounts ~uid
           ~getenv:(function "HOME" -> Some root | _ -> None)
           ~file ~kind:C.Claude ~conversation:sid ~from_account:"default"
           ~to_account:"travel" ());
      Alcotest.(check bool) "no target folder" false (exists travel))

let () =
  Alcotest.run "mesh-accounts-carry-hardening"
    [
      ( "hardening",
        [
          Alcotest.test_case "writable source files" `Quick
            test_writable_source_files;
          Alcotest.test_case "writable target file" `Quick
            test_writable_target_file;
          Alcotest.test_case "Codex layout" `Quick test_codex_layout;
          Alcotest.test_case "lock ignores case" `Quick test_lock_ignores_case;
          Alcotest.test_case "older copy kept until a carry succeeds" `Quick
            test_older_copy_kept_until_success;
          Alcotest.test_case "failed read" `Quick test_failed_read_is_refused;
          Alcotest.test_case "source changed during the copy" `Quick
            test_source_changed_during_copy;
          Alcotest.test_case "incomplete rollback" `Quick
            test_incomplete_rollback_is_reported;
          Alcotest.test_case "missing source" `Quick
            test_missing_source_creates_nothing;
        ] );
    ]
