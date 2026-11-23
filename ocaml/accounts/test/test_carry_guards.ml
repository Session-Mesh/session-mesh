(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The guards of a carry: its size and the target's free space, the lock
   between two carries, a killed carry's leftovers, exact Codex ids, private
   subfolders, clean messages, a target folder created for nothing, and a
   replaced copy that cannot be put back. *)

open Carry_fixture

let no_control text =
  String.for_all (fun c -> Char.code c >= 0x20 && Char.code c <> 0x7f) text

let file_size path = (Unix.stat path).Unix.st_size

let conversation_bytes source =
  List.fold_left
    (fun total relative -> total + file_size (Filename.concat source relative))
    0
    [
      transcript; own ^ "/subagents/agent-1.jsonl"; own ^ "/tool-results/r1.txt";
    ]

let test_default_limits () =
  Alcotest.(check int) "files" 5000 C.default_limits.C.max_files;
  Alcotest.(check int) "bytes" 2147483648 C.default_limits.C.max_bytes;
  Alcotest.(check int) "margin" 536870912 C.default_limits.C.free_margin

let test_too_large () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      let before = listing target in
      List.iter
        (fun limits ->
          refused_with "conversation_too_large"
            (carry ~limits ~source ~target C.Claude))
        [
          { C.default_limits with C.max_files = 2 };
          { C.default_limits with C.max_bytes = 10 };
        ];
      (* a sparse transcript just over 2 GiB, with the default limits *)
      Unix.truncate
        (Filename.concat source transcript)
        (C.default_limits.C.max_bytes + 1);
      refused_with "conversation_too_large" (carry ~source ~target C.Claude);
      Alcotest.(check (list string)) "nothing written" before (listing target))

let test_free_space () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      let before = listing target in
      let needed = conversation_bytes source + C.default_limits.C.free_margin in
      let io free = failing_io ~free () in
      refused_with "target_no_space"
        (carry ~io:(io (Some (needed - 1))) ~source ~target C.Claude);
      Alcotest.(check (list string)) "nothing written" before (listing target);
      refused_with "carry_failed" (carry ~io:(io None) ~source ~target C.Claude);
      ignore (carried (carry ~io:(io (Some needed)) ~source ~target C.Claude));
      let again = carried (carry ~io:(io (Some 0)) ~source ~target C.Claude) in
      Alcotest.(check int) "nothing to write needs no space" 3 again.C.unchanged;
      match C.default_io.C.free_bytes root with
      | Some free -> Alcotest.(check bool) "statvfs" true (free > 0)
      | None -> Alcotest.fail "statvfs failed")

(* A full disk in the middle of a file: the target is as it was, without a
   temporary file. *)
let test_disk_full_mid_file () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      write (Filename.concat source transcript) (String.make 300_000 'x');
      let target = claude_account root "b" in
      write (Filename.concat target transcript) "x";
      let before = listing target in
      refused_with "carry_failed"
        (carry ~io:(failing_io ~writes:2 ()) ~source ~target C.Claude);
      Alcotest.(check (list string)) "as before" before (listing target);
      Alcotest.(check string)
        "the older copy" "x"
        (read (Filename.concat target transcript)))

(* Two processes carry one conversation into one folder: the second is
   refused while the first writes, another conversation goes on, and the
   first completes. *)
let test_concurrent_carries () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let other = "1f1e2d3c-4b5a-4968-8778-695a4b3c2d1e" in
      write (Filename.concat source (project ^ "/" ^ other ^ ".jsonl")) "{}\n";
      let target = claude_account root "b" in
      let results = ref [] in
      let status =
        while_carrying ~source ~target (fun () ->
            let second = carry ~source ~target C.Claude in
            let another = carry ~conversation:other ~source ~target C.Claude in
            results := [ second; another ])
      in
      match !results with
      | [ second; another ] ->
          refused_with "carry_in_progress" second;
          ignore (carried another);
          Alcotest.(check bool)
            "the first carry completed" true (status = Unix.WEXITED 0);
          let again = carried (carry ~source ~target C.Claude) in
          Alcotest.(check int) "its files are in place" 3 again.C.unchanged
      | _ -> Alcotest.fail "the other carries did not run")

let test_lock_file_is_checked () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      let outside = Filename.concat root "outside" in
      write outside "";
      Unix.symlink outside (Filename.concat target C.lock_name);
      refused_with "unsafe_entry" (carry ~source ~target C.Claude);
      Unix.unlink (Filename.concat target C.lock_name);
      write (Filename.concat target C.lock_name) "";
      Unix.chmod (Filename.concat target C.lock_name) 0o644;
      refused_with "unsafe_entry" (carry ~source ~target C.Claude);
      Alcotest.(check bool)
        "nothing written" false
        (exists (Filename.concat target "projects")))

(* What a killed carry left: its temporary files next to the files to write
   are removed, an old copy whose file is missing goes back in place, and
   nothing else is touched. *)
let test_leftovers_of_a_killed_carry () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      write
        (Filename.concat source
           (own ^ "/tool-results/.r1.txt.carry-new-0123456789abcdef"))
        "partial";
      let target = claude_account root "b" in
      let in_target relative = Filename.concat target relative in
      let hex = "0123456789abcdef" in
      let removed =
        [
          project ^ "/." ^ sid ^ ".jsonl.carry-new-" ^ hex;
          project ^ "/." ^ sid ^ ".jsonl.carry-old-" ^ hex;
          own ^ "/tool-results/.r1.txt.carry-new-" ^ hex;
        ]
      and kept =
        [
          project ^ "/." ^ sid ^ ".jsonl.carry-new-FEDCBA9876543210";
          project ^ "/." ^ sid ^ ".jsonl.carry-new-0123";
          project ^ "/.other-conversation.jsonl.carry-new-" ^ hex;
          project ^ "/" ^ sid ^ ".jsonl.carry-new-" ^ hex;
        ]
      in
      List.iter
        (fun relative -> write (in_target relative) "stale")
        (removed @ kept);
      write (in_target transcript) "{\"line\":1}\n";
      let outcome = carried (carry ~source ~target C.Claude) in
      Alcotest.(check int)
        "the source's temporary is not carried" 3 outcome.C.files;
      List.iter
        (fun relative ->
          Alcotest.(check bool)
            (relative ^ " removed") false
            (exists (in_target relative)))
        removed;
      List.iter
        (fun relative ->
          Alcotest.(check bool)
            (relative ^ " kept") true
            (exists (in_target relative)))
        kept)

(* The old copy of a file that is missing is put back, then replaced. *)
let test_old_copy_put_back () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "c" in
      write
        (Filename.concat target
           (project ^ "/." ^ sid ^ ".jsonl.carry-old-0123456789abcdef"))
        "{\"line\":1}\n";
      let outcome = carried (carry ~source ~target C.Claude) in
      Alcotest.(check int) "replaced, not copied" 1 outcome.C.replaced;
      Alcotest.(check bool)
        "no leftover" false
        (List.exists (fun path -> contains path ".carry-") (listing target)))

(* Codex ids are whole UUIDs, matched exactly in the rollout's name. *)
let test_codex_ids_match_exactly () =
  with_root (fun root ->
      let source = Filename.concat root "a"
      and target = Filename.concat root "b" in
      write (Filename.concat source rollout) "{}\n";
      mkdirs target;
      List.iter
        (fun conversation ->
          refused_with "conversation_unknown"
            (carry ~conversation ~source ~target C.Codex))
        [ "695a4b3c2d1e"; "8778-695a4b3c2d1e"; "4b5a-4968-8778-695a4b3c2d1e" ];
      let source = Filename.concat root "c" in
      List.iter
        (fun name ->
          write (Filename.concat source ("sessions/2026/11/20/" ^ name)) "{}\n")
        [
          "rollout-2026-11-20T09-00-00-extra-" ^ sid ^ ".jsonl";
          "rollout-" ^ sid ^ ".jsonl";
          "rollout-2026-11-20T09-00-00-" ^ sid ^ ".jsonl.bak";
          "rollout-2026-11-20T09-00-0x-" ^ sid ^ ".jsonl";
        ];
      refused_with "conversation_not_found" (carry ~source ~target C.Codex);
      Alcotest.(check (list string)) "nothing written" [] (listing target))

(* A folder group or others can write, in the source or the target, refuses
   the carry. *)
let test_writable_subfolders () =
  with_root (fun root ->
      let cases =
        [
          ("source", own ^ "/subagents", 0o770);
          ("source", project, 0o757);
          ("source", "projects", 0o775);
          ("target", project, 0o770);
        ]
      in
      List.iteri
        (fun index (side, folder, mode) ->
          let source = claude_account root (Printf.sprintf "s%d" index) in
          let target = claude_account root (Printf.sprintf "t%d" index) in
          with_conversation source;
          let where = if side = "source" then source else target in
          mkdirs (Filename.concat where folder);
          Unix.chmod (Filename.concat where folder) mode;
          refused_with "unsafe_entry" (carry ~source ~target C.Claude);
          Alcotest.(check bool)
            "no transcript written" false
            (exists (Filename.concat target transcript)))
        cases;
      let source = Filename.concat root "codex" in
      write (Filename.concat source rollout) "{}\n";
      Unix.chmod (Filename.concat source "sessions/2026") 0o777;
      let target = Filename.concat root "codex-target" in
      mkdirs target;
      refused_with "unsafe_entry" (carry ~source ~target C.Codex))

(* Messages carry no control character, no absolute path, and do not repeat
   an unknown alias. *)
let test_messages_are_clean () =
  with_root (fun root ->
      let source = claude_account root ".claude" in
      with_conversation source;
      let target = claude_account root "b" in
      Unix.symlink "nowhere"
        (Filename.concat source (own ^ "/tool-results/bad\027[31mname\n"));
      let refusal = carry ~source ~target C.Claude in
      refused_with "unsafe_entry" refusal;
      Alcotest.(check bool)
        "no control character" true
        (no_control (message_of refusal));
      let file = Filename.concat root "accounts.json" in
      write file
        (Printf.sprintf
           {|{"v": 1, "accounts": [{"id": "work", "label": "Work", "claude_config_dir": "%s/work"}]}|}
           root);
      let hostile = "x\027[31mRED\nline2" in
      let refusal =
        C.carry_accounts ~uid
          ~getenv:(function "HOME" -> Some root | _ -> None)
          ~file ~kind:C.Claude ~conversation:sid ~from_account:"default"
          ~to_account:hostile ()
      in
      refused_with "account_unknown" refusal;
      let message = message_of refusal in
      Alcotest.(check bool) "no control character" true (no_control message);
      Alcotest.(check bool)
        "the alias is not repeated" false (contains message "RED"))

(* Without cleanup custody, a newly made target remains after refusal. *)
let test_target_created_only_for_a_carry () =
  with_root (fun root ->
      let travel = Filename.concat root "travel/.claude" in
      mkdirs (Filename.dirname travel);
      let file = Filename.concat root "accounts.json" in
      write file
        (Printf.sprintf
           {|{"v": 1, "accounts": [{"id": "travel", "label": "Travel", "claude_config_dir": "%s"}]}|}
           travel);
      let source = claude_account root ".claude" in
      let run () =
        C.carry_accounts ~uid
          ~getenv:(function "HOME" -> Some root | _ -> None)
          ~file ~kind:C.Claude ~conversation:sid ~from_account:"default"
          ~to_account:"travel" ()
      in
       refused_with "carry_rollback_incomplete" (run ());
       Alcotest.(check bool) "unproven target retained" true (exists travel);
      with_conversation source;
      ignore (carried (run ()));
      Alcotest.(check bool)
        "carried" true
        (exists (Filename.concat travel transcript)))

(* A replaced copy that cannot be put back is kept under its temporary name,
   reported, and put back by the next carry. *)
let test_a_replaced_copy_that_cannot_be_put_back () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      List.iter
        (fun (label, renames) ->
          let target = claude_account root label in
          write (Filename.concat target transcript) "{\"line\":1}\n";
          let refusal =
            carry
              ~io:(failing_io ~renames ~restores:false ())
              ~source ~target C.Claude
          in
          refused_with "carry_restore_failed" refusal;
          let message = message_of refusal in
          Alcotest.(check bool)
            (label ^ ": names the kept copy")
            true
            (contains message ("." ^ sid ^ ".jsonl.carry-old-"));
          Alcotest.(check bool)
            (label ^ ": no absolute path")
            false (contains message root);
          let olds =
            List.filter
              (fun path -> contains path ".carry-old-")
              (listing target)
          in
          Alcotest.(check int) (label ^ ": one old copy") 1 (List.length olds);
          Alcotest.(check string)
            (label ^ ": the older content")
            "{\"line\":1}\n"
            (read (Filename.concat target (List.hd olds)));
          let outcome = carried (carry ~source ~target C.Claude) in
          Alcotest.(check int) (label ^ ": files") 3 outcome.C.files;
          Alcotest.(check string)
            (label ^ ": the source's copy")
            (read (Filename.concat source transcript))
            (read (Filename.concat target transcript));
          Alcotest.(check bool)
            (label ^ ": no old copy left")
            false
            (List.exists (fun path -> contains path ".carry-") (listing target)))
        [ ("in-commit", 0); ("in-roll-back", 1) ])

let () =
  Alcotest.run "mesh-accounts-carry-guards"
    [
      ( "guards",
        [
          Alcotest.test_case "default limits" `Quick test_default_limits;
          Alcotest.test_case "too large" `Quick test_too_large;
          Alcotest.test_case "free space" `Quick test_free_space;
          Alcotest.test_case "disk full mid-file" `Quick test_disk_full_mid_file;
          Alcotest.test_case "two concurrent carries" `Quick
            test_concurrent_carries;
          Alcotest.test_case "lock file" `Quick test_lock_file_is_checked;
          Alcotest.test_case "leftovers of a killed carry" `Quick
            test_leftovers_of_a_killed_carry;
          Alcotest.test_case "an old copy put back" `Quick
            test_old_copy_put_back;
          Alcotest.test_case "exact Codex ids" `Quick
            test_codex_ids_match_exactly;
          Alcotest.test_case "writable subfolders" `Quick
            test_writable_subfolders;
          Alcotest.test_case "clean messages" `Quick test_messages_are_clean;
          Alcotest.test_case "target created only for a carry" `Quick
            test_target_created_only_for_a_carry;
          Alcotest.test_case "a replaced copy that cannot be put back" `Quick
            test_a_replaced_copy_that_cannot_be_put_back;
        ] );
    ]
