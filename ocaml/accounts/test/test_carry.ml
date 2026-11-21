(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Carrying one conversation from an account's folder to another's: only the
   conversation's own files, never a link, never a login file, never over a
   different copy, and nothing left behind when the copy fails. The bounds,
   the lock and the other guards are in test_carry_guards.ml. *)

open Carry_fixture

let test_claude_conversation () =
  with_root (fun root ->
      let source = claude_account root "a" in
      let target = claude_account root "b" in
      with_conversation source;
      let outcome = carried (carry ~source ~target C.Claude) in
      Alcotest.(check int) "three files" 3 outcome.C.files;
      Alcotest.(check (list string))
        "the conversation and its own folder only"
        [
          ".claude.json";
          ".credentials.json";
          "projects";
          project;
          own;
          own ^ ".jsonl";
          own ^ "/subagents";
          own ^ "/subagents/agent-1.jsonl";
          own ^ "/tool-results";
          own ^ "/tool-results/r1.txt";
          "settings.json";
        ]
        (listing target);
      Alcotest.(check string)
        "same content"
        (read (Filename.concat source transcript))
        (read (Filename.concat target transcript));
      Alcotest.(check string)
        "the target's own login is untouched" "{\"secret\":2}"
        (read (Filename.concat target ".claude.json"));
      let mode path = (Unix.stat path).Unix.st_perm land 0o777 in
      Alcotest.(check int)
        "private" 0o600
        (mode (Filename.concat target transcript));
      Alcotest.(check int)
        "private folders" 0o700
        (mode (Filename.concat target project));
      Alcotest.(check int)
        "the lock file stays, private" 0o600
        (mode (Filename.concat target C.lock_name)))

let test_codex_rollout () =
  with_root (fun root ->
      let source = Filename.concat root "a"
      and target = Filename.concat root "b" in
      write (Filename.concat source "auth.json") "{\"secret\":1}";
      write (Filename.concat source "config.toml") "";
      write (Filename.concat source rollout) "{\"type\":\"session_meta\"}\n";
      write
        (Filename.concat source
           "sessions/2026/11/20/rollout-2026-11-20T09-00-00-other.jsonl")
        "x";
      mkdirs target;
      let outcome = carried (carry ~source ~target C.Codex) in
      Alcotest.(check int) "one file" 1 outcome.C.files;
      Alcotest.(check (list string))
        "the rollout at the same place, nothing else"
        [
          "sessions";
          "sessions/2026";
          "sessions/2026/11";
          "sessions/2026/11/20";
          rollout;
        ]
        (listing target))

let test_hostile_ids () =
  with_root (fun root ->
      let source = claude_account root "a" in
      let target = claude_account root "b" in
      with_conversation source;
      List.iter
        (fun conversation ->
          refused_with "conversation_unknown"
            (carry ~conversation ~source ~target C.Claude))
        [ ""; "../a"; "*"; "-rf"; "a/b"; sid ^ ".jsonl"; String.make 80 'a' ];
      Alcotest.(check bool)
        "nothing written" false
        (exists (Filename.concat target "projects")))

let test_not_found_and_ambiguous () =
  with_root (fun root ->
      let source = claude_account root "a" in
      let target = claude_account root "b" in
      refused_with "conversation_not_found" (carry ~source ~target C.Claude);
      with_conversation source;
      write
        (Filename.concat source ("projects/-elsewhere/" ^ sid ^ ".jsonl"))
        "x";
      refused_with "conversation_ambiguous" (carry ~source ~target C.Claude))

let test_links_are_refused () =
  with_root (fun root ->
      let outside = Filename.concat root "outside" in
      write (Filename.concat outside "secret.jsonl") "outside";
      let cases =
        [
          (* the transcript itself *)
          (fun source ->
            mkdirs (Filename.concat source project);
            Unix.symlink
              (Filename.concat outside "secret.jsonl")
              (Filename.concat source transcript));
          (* a file of its folder *)
          (fun source ->
            with_conversation source;
            Unix.symlink
              (Filename.concat outside "secret.jsonl")
              (Filename.concat source (own ^ "/tool-results/l")));
          (* a folder of its folder *)
          (fun source ->
            with_conversation source;
            Unix.symlink outside (Filename.concat source (own ^ "/linked")));
        ]
      in
      List.iteri
        (fun index plant ->
          let source = claude_account root (Printf.sprintf "s%d" index) in
          let target = claude_account root (Printf.sprintf "t%d" index) in
          plant source;
          refused_with "unsafe_entry" (carry ~source ~target C.Claude);
          Alcotest.(check bool)
            "nothing written" false
            (exists (Filename.concat target "projects")))
        cases)

let test_target_links_are_refused () =
  with_root (fun root ->
      let outside = Filename.concat root "outside" in
      mkdirs outside;
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      Unix.symlink outside (Filename.concat target "projects");
      refused_with "unsafe_entry" (carry ~source ~target C.Claude);
      Alcotest.(check (list string)) "outside untouched" [] (listing outside);
      let target = claude_account root "c" in
      mkdirs (Filename.concat target project);
      Unix.symlink
        (Filename.concat outside "planted")
        (Filename.concat target transcript);
      refused_with "unsafe_entry" (carry ~source ~target C.Claude);
      Alcotest.(check (list string))
        "no file through the link" [] (listing outside))

(* A target project folder that is a link to a folder holding an identical
   copy: refused like any link, although nothing would be written. *)
let test_target_link_to_identical_copy () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let copy = claude_account root "copy" in
      ignore (carried (carry ~source ~target:copy C.Claude));
      let target = claude_account root "b" in
      mkdirs (Filename.concat target "projects");
      Unix.symlink
        (Filename.concat copy project)
        (Filename.concat target project);
      refused_with "unsafe_entry" (carry ~source ~target C.Claude))

let test_login_files_are_never_carried () =
  with_root (fun root ->
      List.iteri
        (fun index name ->
          let source = claude_account root (Printf.sprintf "s%d" index) in
          let target = claude_account root (Printf.sprintf "t%d" index) in
          with_conversation source;
          write
            (Filename.concat source (own ^ "/tool-results/" ^ name))
            "{\"secret\":1}";
          refused_with "unsafe_entry" (carry ~source ~target C.Claude);
          Alcotest.(check bool)
            (name ^ ": nothing written")
            false
            (exists (Filename.concat target "projects")))
        [
          ".credentials.json";
          ".claude.json";
          "auth.json";
          "AUTH.JSON";
          "credentials.json";
          ".Credentials.json";
          ".claude.json.backup.1763600000";
          "config.toml";
          ".env";
          ".env.local";
          "settings.json";
          "settings.local.json";
          "server.pem";
          "private.KEY";
          "id_rsa";
          "id_ed25519.pub";
        ];
      List.iter
        (fun name ->
          Alcotest.(check bool)
            (name ^ " is carried") false (C.is_login_file name))
        [ "agent-1.jsonl"; "r1.txt"; "toolu_01.txt"; "keyboard.md"; "env.txt" ])

(* A file of the conversation hard-linked to a file elsewhere (a credential
   under an innocent name) is refused. *)
let test_hard_links_are_refused () =
  with_root (fun root ->
      let source = claude_account root "a" in
      let target = claude_account root "b" in
      with_conversation source;
      Unix.link
        (Filename.concat source ".credentials.json")
        (Filename.concat source (own ^ "/tool-results/innocent.txt"));
      refused_with "unsafe_entry" (carry ~source ~target C.Claude);
      Alcotest.(check bool)
        "nothing written" false
        (exists (Filename.concat target "projects")))

let test_round_trip_and_divergence () =
  with_root (fun root ->
      let source = claude_account root "a" in
      let target = claude_account root "b" in
      with_conversation source;
      ignore (carried (carry ~source ~target C.Claude));
      (* the same files again: nothing to do *)
      let again = carried (carry ~source ~target C.Claude) in
      Alcotest.(check int) "unchanged" 3 again.C.unchanged;
      (* the conversation went on in the source: the older copy is a prefix *)
      let path = Filename.concat source transcript in
      write path (read path ^ "{\"line\":3}\n");
      let grown = carried (carry ~source ~target C.Claude) in
      Alcotest.(check int) "replaced" 1 grown.C.replaced;
      Alcotest.(check string)
        "the longer copy" (read path)
        (read (Filename.concat target transcript));
      (* the target went on separately: a different copy is never replaced *)
      let target_path = Filename.concat target transcript in
      write target_path
        "{\"line\":1}\n{\"other\":2}\n{\"other\":3}\n{\"x\":4}\n";
      let before = read target_path in
      refused_with "conversation_diverged" (carry ~source ~target C.Claude);
      Alcotest.(check string) "kept" before (read target_path))

(* A failure while writing (a full disk), closing or putting files in place
   leaves the target as it was: no new file, no temporary file, a replaced
   copy back. *)
let test_a_failed_copy_changes_nothing () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      List.iter
        (fun (label, io) ->
          let target = claude_account root ("t-" ^ label) in
          let before = listing target in
          refused_with "carry_failed" (carry ~io ~source ~target C.Claude);
          Alcotest.(check (list string))
            (label ^ ": as before") before (listing target))
        [
          ("first-write", failing_io ~writes:0 ());
          ("second-write", failing_io ~writes:1 ());
          ("second-rename", failing_io ~renames:1 ());
          ("first-close", failing_io ~closes:0 ());
          ("third-close", failing_io ~closes:2 ());
        ];
      (* with an older copy in place, a failed replacement keeps it *)
      let target = claude_account root "older" in
      write (Filename.concat target transcript) "{\"line\":1}\n";
      let before = listing target in
      refused_with "carry_failed"
        (carry ~io:(failing_io ~renames:2 ()) ~source ~target C.Claude);
      Alcotest.(check (list string)) "as before" before (listing target);
      Alcotest.(check string)
        "the older copy" "{\"line\":1}\n"
        (read (Filename.concat target transcript)))

let test_same_folder_is_refused () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      refused_with "account_same" (carry ~source ~target:source C.Claude))

(* The folders themselves pass the alias rules (no link, private); the
   refusal names no absolute path. *)
let test_unchecked_folders_are_refused () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      Unix.chmod target 0o777;
      let refusal = carry ~source ~target C.Claude in
      refused_with "account_folder_refused" refusal;
      Alcotest.(check bool)
        "no absolute path" false
        (contains (message_of refusal) root);
      Unix.chmod target 0o700;
      let linked = Filename.concat root "linked" in
      Unix.symlink target linked;
      refused_with "account_folder_refused"
        (carry ~source ~target:linked C.Claude))

(* Resolving the folders from accounts.json: an alias's own folder for the
   agent, "default" from the environment, refusals with their code. *)
let test_account_folders () =
  with_root (fun root ->
      let work = Filename.concat root "work-claude" in
      mkdirs work;
      let file = Filename.concat root "accounts.json" in
      write file
        (Printf.sprintf
           {|{"v": 1, "accounts": [{"id": "work", "label": "Work", "claude_config_dir": "%s"}]}|}
           work);
      let getenv = function "HOME" -> Some root | _ -> None in
      let folder account kind =
        C.account_folder ~uid ~getenv ~file ~kind ~create:false account
      in
      let code account kind =
        Result.map_error (fun e -> e.C.code) (folder account kind)
      in
      Alcotest.(check (result string string))
        "alias" (Ok work) (code "work" C.Claude);
      mkdirs (Filename.concat root ".claude");
      Alcotest.(check (result string string))
        "default"
        (Ok (Filename.concat root ".claude"))
        (code "default" C.Claude);
      Alcotest.(check (result string string))
        "no Codex folder" (Error "account_no_agent") (code "work" C.Codex);
      Alcotest.(check (result string string))
        "unknown" (Error "account_unknown") (code "nobody" C.Claude);
      Unix.chmod work 0o777;
      let refusal = folder "work" C.Claude in
      Alcotest.(check (result string string))
        "refused alias folder" (Error "accounts_refused")
        (Result.map_error (fun e -> e.C.code) refusal);
      Alcotest.(check bool)
        "no absolute path" false
        (contains (message_of refusal) root);
      Unix.chmod work 0o700;
      Unix.chmod file 0o666;
      Alcotest.(check (result string string))
        "refused file" (Error "accounts_refused") (code "work" C.Claude))

(* An agent killed while writing (a restart sends SIGKILL to an agent still
   running 3 s after SIGHUP) can leave its last line cut. The carry copies the
   file byte for byte: the other account reads exactly what this one would,
   the source is untouched, and once the source is whole again a later carry
   replaces the cut copy (a prefix). *)
let test_cut_last_line () =
  with_root (fun root ->
      let check_cut kind source target relative =
        let path = Filename.concat source relative in
        let cut = "{\"type\":\"session_meta\"}\n{\"type\":\"user\",\"mess" in
        write path cut;
        ignore (carried (carry ~source ~target kind));
        Alcotest.(check string)
          "the same bytes, cut line included" cut
          (read (Filename.concat target relative));
        Alcotest.(check string) "the source is untouched" cut (read path);
        write path (cut ^ "age\":1}\n");
        let whole = carried (carry ~source ~target kind) in
        Alcotest.(check int) "the cut copy is replaced" 1 whole.C.replaced;
        Alcotest.(check string)
          "by the whole one" (read path)
          (read (Filename.concat target relative))
      in
      check_cut C.Claude (claude_account root "a") (claude_account root "b")
        transcript;
      let codex name =
        let folder = Filename.concat root name in
        mkdirs folder;
        folder
      in
      check_cut C.Codex (codex "c") (codex "d") rollout)

let () =
  Alcotest.run "mesh-accounts-carry"
    [
      ( "carry",
        [
          Alcotest.test_case "a Claude conversation and its folder" `Quick
            test_claude_conversation;
          Alcotest.test_case "a Codex rollout" `Quick test_codex_rollout;
          Alcotest.test_case "hostile conversation ids" `Quick test_hostile_ids;
          Alcotest.test_case "not found, ambiguous" `Quick
            test_not_found_and_ambiguous;
          Alcotest.test_case "links in the source" `Quick test_links_are_refused;
          Alcotest.test_case "links in the target" `Quick
            test_target_links_are_refused;
          Alcotest.test_case "target link to an identical copy" `Quick
            test_target_link_to_identical_copy;
          Alcotest.test_case "login files are never carried" `Quick
            test_login_files_are_never_carried;
          Alcotest.test_case "hard links" `Quick test_hard_links_are_refused;
          Alcotest.test_case "round trip and divergence" `Quick
            test_round_trip_and_divergence;
          Alcotest.test_case "a failed copy changes nothing" `Quick
            test_a_failed_copy_changes_nothing;
          Alcotest.test_case "same folder" `Quick test_same_folder_is_refused;
          Alcotest.test_case "unchecked folders" `Quick
            test_unchecked_folders_are_refused;
          Alcotest.test_case "account folders" `Quick test_account_folders;
          Alcotest.test_case "a cut last line is carried as it is" `Quick
            test_cut_last_line;
        ] );
    ]
