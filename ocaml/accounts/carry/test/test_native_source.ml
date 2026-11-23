(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

open Carry_fixture

let with_native_root test () =
  with_root (fun root ->
      let root = Unix.realpath root in
      Unix.chmod root 0o700;
      test root)

let path = Filename.concat
let file root = path root "accounts.json"
let registry_file root = path root "backend-profiles.json"
let getenv _ = None

let profile ?(enabled = true) backend id label config =
  let role, child =
    if backend = "codex" then ("state", "sessions") else ("history", "projects")
  in
  `Assoc
    [
      ("id", `String id);
      ("label", `String label);
      ("backend", `String backend);
      ("enabled", `Bool enabled);
      ( "roots",
        `Assoc
          [
            ("config", `String config);
            (role, `String (path config child));
          ] );
    ]

let registry root profiles =
  write (registry_file root)
    (Yojson.Safe.to_string
       (`Assoc [ ("version", `Int 1); ("profiles", `List profiles) ]))

let native_pair ?(source_enabled = true) ?(target_enabled = true) root =
  registry root
    [
      profile ~enabled:source_enabled "claude" "work" "other"
        (path root "native-source");
      profile ~enabled:target_enabled "claude" "other" "work"
        (path root "native-target");
    ]

let legacy_pair root =
  write (file root)
    (Printf.sprintf
       {|{"v":1,"accounts":[{"id":"work","label":"Legacy source","claude_config_dir":"%s/legacy-source","codex_home":"%s/legacy-codex-source"},{"id":"other","label":"Legacy target","claude_config_dir":"%s/legacy-target","codex_home":"%s/legacy-codex-target"}]}|}
       root root root root)

let carry_named ?(io = failing_io ()) ?(kind = C.Claude) root =
  C.carry_accounts ~io ~uid ~getenv ~file:(file root) ~kind ~conversation:sid
    ~from_account:"work" ~to_account:"other" ()

let folder ?(create = false) ?(kind = C.Claude) root account =
  C.account_folder ~uid ~getenv ~file:(file root) ~kind ~create account

let resolved = function
  | Ok value -> value
  | Error { C.code; message } -> Alcotest.failf "%s: %s" code message

let test_expected_pair_revisions root =
  let module R = Mesh_account_resolver in
  let source = claude_account root "native-source" in
  with_conversation source;
  native_pair root;
  let accounts = Result.get_ok (R.load ~uid ~file:(file root)) in
  let revision id =
    let entry = Result.get_ok (R.find accounts { R.backend = R.Claude; id }) in
    Option.get (R.context_revision entry)
  in
  let source_revision, target_revision = (revision "work", revision "other") in
  let run expected_contexts =
    C.carry_accounts ~expected_contexts ~uid ~getenv ~file:(file root)
      ~kind:C.Claude ~conversation:sid ~from_account:"work" ~to_account:"other" ()
  in
  refused_with "profile-context-changed" (run (String.make 64 '0', target_revision));
  refused_with "profile-context-changed" (run (source_revision, String.make 64 '0'));
  refused_with "profile-context-changed"
    (C.carry_accounts ~expected_contexts:(source_revision, target_revision)
       ~uid ~getenv ~file:(file root) ~kind:C.Claude ~conversation:sid
       ~from_account:"default" ~to_account:"other" ());
  registry root
    [ profile "claude" "work" "other" (path root "native-source");
      profile "claude" "other" "work" (path root "changed-target") ];
  refused_with "profile-context-changed" (run (source_revision, target_revision));
  Alcotest.(check bool) "changed target never created" false (exists (path root "changed-target"));
  native_pair root;
  Alcotest.(check bool) "mismatch never creates target" false (exists (path root "native-target"));
  ignore (carried (run (source_revision, target_revision)));
  Alcotest.(check bool) "matching pair copies conversation" true
    (exists (path root ("native-target/" ^ transcript)));
  (* A source read from the legacy file cannot pretend to be a bound native pair. *)
  Unix.unlink (registry_file root);
  legacy_pair root;
  refused_with "profile-context-changed" (run (source_revision, target_revision))

let test_migrated_actual_carry root =
  let source = claude_account root "native-source" in
  with_conversation source;
  write (path source transcript) "{\"native\":\"claude\"}\n";
  Unix.chmod (path source ".credentials.json") 0o000;
  let stale = claude_account root "legacy-source" in
  with_conversation stale;
  write (path stale transcript) "{\"stale\":true}\n";
  legacy_pair root;
  registry root
    [
      profile "claude" "work" "other" source;
      profile "codex" "work" "Codex source" (path root "native-codex-source");
      profile "claude" "other" "work" (path root "native-target");
      profile "codex" "other" "Codex target" (path root "native-codex-target");
    ];
  let outcome = carried (carry_named root) in
  Alcotest.(check int) "actual Claude conversation copied" 3 outcome.C.files;
  Alcotest.(check string) "native source selected despite stale legacy"
    (read (path source transcript))
    (read (path root ("native-target/" ^ transcript)));
  Alcotest.(check bool) "stale legacy target not prepared" false
    (exists (path root "legacy-target"));
  Alcotest.(check bool) "other backend source not prepared" false
    (exists (path root "native-codex-source"));
  Alcotest.(check bool) "other backend target not prepared" false
    (exists (path root "native-codex-target"));
  Alcotest.(check bool) "source credentials not copied" false
    (exists (path root "native-target/.credentials.json"));
  Alcotest.(check int) "source credential mode untouched" 0
    ((Unix.lstat (path source ".credentials.json")).Unix.st_perm land 0o777);
  let codex_source = path root "native-codex-source" in
  write (path codex_source rollout) "{\"native\":\"codex\"}\n";
  let codex = carried (carry_named ~kind:C.Codex root) in
  Alcotest.(check int) "same source/target IDs independently select Codex" 1
    codex.C.files;
  Alcotest.(check string) "Codex copied to its own target"
    (read (path codex_source rollout))
    (read (path root ("native-codex-target/" ^ rollout)));
  Alcotest.(check bool) "stale Codex target not prepared" false
    (exists (path root "legacy-codex-target"));
  refused_with "account_unknown" (folder root "Legacy source");
  refused_with "account_unknown" (folder root "wor");
  Alcotest.(check string) "id lookup is not confused by the other profile's label"
    source (resolved (folder root "work"))

let test_malformed_never_falls_back root =
  let stale = claude_account root "legacy-source" in
  with_conversation stale;
  legacy_pair root;
  write (registry_file root) "{";
  refused_with "accounts_refused" (carry_named root);
  refused_with "accounts_refused" (folder ~create:true root "work");
  Alcotest.(check bool) "legacy target untouched" false
    (exists (path root "legacy-target"));
  Alcotest.(check bool) "no native target created" false
    (exists (path root "native-target"));
  Unix.unlink (registry_file root);
  Unix.symlink (path root "absent-registry") (registry_file root);
  refused_with "accounts_refused" (carry_named root);
  Alcotest.(check bool) "dangling registry is not legacy permission" false
    (exists (path root "legacy-target"))

let test_disabled_named_accounts root =
  let source = claude_account root "native-source" in
  with_conversation source;
  legacy_pair root;
  native_pair ~source_enabled:false root;
  refused_with "account_unknown" (carry_named root);
  native_pair ~target_enabled:false root;
  refused_with "account_unknown" (carry_named root);
  refused_with "account_unknown" (folder ~create:true root "other");
  Alcotest.(check bool) "disabled target not prepared" false
    (exists (path root "native-target"));
  Alcotest.(check bool) "disabled lookup never falls back to legacy" false
    (exists (path root "legacy-target"));
  registry root [ profile "codex" "work" "Codex source" (path root "codex-only") ];
  refused_with "account_no_agent" (folder root "work");
  Alcotest.(check bool) "wrong-backend lookup does not prepare" false
    (exists (path root "codex-only"))

let test_missing_source_not_prepared root =
  native_pair root;
  Alcotest.(check string) "non-creating source lookup"
    (path root "native-source") (resolved (folder root "work"));
  refused_with "account_folder_refused" (carry_named root);
  Alcotest.(check bool) "source remains absent" false
    (exists (path root "native-source"));
  Alcotest.(check bool) "target not created for missing source" false
    (exists (path root "native-target"))

let test_created_target_rollback root =
  let source = claude_account root "native-source" in
  native_pair root;
  refused_with "carry_rollback_incomplete" (carry_named root);
  Alcotest.(check bool) "unproven target retained when no conversation found" true
    (exists (path root "native-target"));
  with_conversation source;
  refused_with "carry_rollback_incomplete" (carry_named ~io:(failing_io ~writes:0 ()) root);
  Alcotest.(check bool) "unproven child retained after failed write" true
    (exists (path root "native-target"));
  ignore (carried (carry_named root));
  Alcotest.(check bool) "successful created target retained" true
    (exists (path root ("native-target/" ^ transcript)))

let test_existing_target_retention root =
  let source = claude_account root "native-source" in
  with_conversation source;
  let target = claude_account root "native-target" in
  let before = listing target in
  native_pair root;
  refused_with "carry_rollback_incomplete" (carry_named ~io:(failing_io ~writes:0 ()) root);
  Alcotest.(check bool) "pre-existing target retained" true (exists target);
  List.iter
    (fun relative ->
      Alcotest.(check bool) "pre-existing entry retained" true
        (exists (path target relative)))
    before;
  Alcotest.(check bool) "no staged copy left" false
    (List.exists (fun name -> contains name ".carry-new-") (listing target));
  Alcotest.(check string) "target login unchanged" "{\"secret\":1}"
    (read (path target ".credentials.json"))

let test_explicit_default_without_registry root =
  let default = claude_account root ".claude" in
  with_conversation default;
  let getenv = function "HOME" -> Some root | _ -> None in
  let folder account =
    C.account_folder ~uid ~getenv ~file:(file root) ~kind:C.Claude ~create:false
      account
  in
  Alcotest.(check string) "explicit default needs no accounts file" default
    (resolved (folder "default"));
  write (registry_file root) "{";
  Alcotest.(check string) "explicit default preserves independent source" default
    (resolved (folder "default"));
  refused_with "accounts_refused" (folder "unknown-named-account");
  refused_with "account_same"
    (C.carry_accounts ~uid ~getenv ~file:(file root) ~kind:C.Claude
       ~conversation:sid ~from_account:"default" ~to_account:"default" ());
  refused_with "accounts_refused"
    (C.carry_accounts ~uid ~getenv ~file:(file root) ~kind:C.Claude
       ~conversation:sid ~from_account:"default" ~to_account:"work" ());
  Alcotest.(check bool) "named target never defaulted" false
    (exists (path root "native-target"))

(* The existing environment callback is a deterministic boundary between folder
   lookups. Configuration must already have been read, even for a default source.
   Changing it here must not select a target from a second snapshot. *)
let test_one_snapshot_before_folder_lookup root =
  let source = claude_account root ".claude" in
  with_conversation source;
  native_pair root;
  let changed = ref false in
  let getenv name =
    if not !changed then begin
      changed := true;
      registry root
        [ profile "claude" "other" "Replacement" (path root "replacement-target") ]
    end;
    if name = "HOME" then Some root else None
  in
  ignore
    (carried
       (C.carry_accounts ~io:(failing_io ()) ~uid ~getenv ~file:(file root)
          ~kind:C.Claude ~conversation:sid ~from_account:"default"
          ~to_account:"other" ()));
  Alcotest.(check bool) "registry changed during folder lookup" true !changed;
  Alcotest.(check string) "target comes from the original snapshot"
    (read (path source transcript))
    (read (path root ("native-target/" ^ transcript)));
  Alcotest.(check bool) "second snapshot target never prepared" false
    (exists (path root "replacement-target"))

let test_registry_change_during_copy_stays_pinned root =
  let source = claude_account root "native-source" in
  with_conversation source;
  native_pair root;
  let changed = ref false in
  let io =
    {
      (failing_io ()) with
      C.free_bytes =
        (fun _ ->
          changed := true;
          registry root
            [
              profile "claude" "work" "New source" (path root "new-source");
              profile "claude" "other" "New target" (path root "new-target");
            ];
          Some max_int);
    }
  in
  ignore (carried (carry_named ~io root));
  Alcotest.(check bool) "registry edited through existing IO hook" true !changed;
  Alcotest.(check string) "entire copy uses pinned old pair"
    (read (path source transcript))
    (read (path root ("native-target/" ^ transcript)));
  Alcotest.(check bool) "new source untouched" false (exists (path root "new-source"));
  Alcotest.(check bool) "new target untouched" false (exists (path root "new-target"))

let check_identity name expected folder =
  let current = Unix.lstat folder in
  Alcotest.(check (pair int int)) name
    (expected.Unix.st_dev, expected.Unix.st_ino)
    (current.Unix.st_dev, current.Unix.st_ino)

module Write = Mesh_accounts_carry__Carry_write

let writer_io (io : C.io) : Write.io =
  {
    write = io.write;
    read = io.read;
    unlink = io.unlink;
    rename = io.rename;
    close = io.close;
    free_bytes = io.free_bytes;
  }

let test_unproven_target_creation_is_not_cleanup_authority root =
  let source = claude_account root "native-source" in
  with_conversation source;
  native_pair root;
  let refusal = carry_named ~io:(failing_io ~writes:0 ()) root in
  refused_with "carry_rollback_incomplete" refusal;
  Alcotest.(check bool) "new target remains for review" true
    (exists (path root "native-target"));
  Alcotest.(check bool) "uncertain target reported" true
    (contains (message_of refusal) "account folder")

let test_unproven_child_creation_is_not_cleanup_authority root =
  let target = claude_account root "native-target" in
  let state : Write.state =
    { created = []; unproven_folders = []; temporary = []; committed = [];
      inflight = None }
  in
  let relative = "projects" in
  (match Write.make_folder ~uid state ~target relative with
  | Ok () -> ()
  | Error error -> Alcotest.fail error.message);
  let child = path target relative in
  let original = Unix.lstat child in
  let undone = Write.roll_back (writer_io (failing_io ())) ~target state in
  check_identity "unproven folder retained" original child;
  Alcotest.(check bool) "unproven cleanup reported" true
    (List.mem relative undone.folders)

let test_injected_proven_custody_still_cleans_empty_folder root =
  let target = claude_account root "native-target" in
  let child = path target "verified-child" in
  Unix.mkdir child 0o700;
  let identity = Unix.lstat child in
  let state : Write.state =
    { created = [ (child, identity) ]; unproven_folders = []; temporary = [];
      committed = []; inflight = None }
  in
  let undone = Write.roll_back (writer_io (failing_io ())) ~target state in
  Alcotest.(check bool) "verified empty folder removed" false (exists child);
  Alcotest.(check (list string)) "no unconfirmed folder" [] undone.folders

let expose_refusal (result : (unit, Mesh_accounts_carry__Carry_base.error) result) =
  Result.map_error
    (fun (error : Mesh_accounts_carry__Carry_base.error) ->
      { C.code = error.code; message = error.message })
    result

let test_default_target_environment_is_pinned root =
  let source = claude_account root "native-source" in
  with_conversation source;
  native_pair root;
  let chosen = path root "chosen-default-target" in
  let preexisting = path root "preexisting-default-target" in
  Unix.mkdir preexisting 0o700;
  let identity = Unix.lstat preexisting in
  let selections = ref 0 in
  let getenv = function
    | "CLAUDE_CONFIG_DIR" ->
        incr selections;
        Some (if !selections = 1 then chosen else preexisting)
    | "HOME" -> Some root
    | _ -> None
  in
  refused_with "carry_rollback_incomplete"
    (C.carry_accounts ~io:(failing_io ~free:(Some 0) ()) ~uid ~getenv
       ~file:(file root) ~kind:C.Claude ~conversation:sid ~from_account:"work"
       ~to_account:"default" ());
  Alcotest.(check int) "default selector read only once" 1 !selections;
  Alcotest.(check bool) "unproven target retained for review" true (exists chosen);
  check_identity "pre-existing empty alternative never removed" identity preexisting;
  Alcotest.(check (list string)) "pre-existing alternative untouched" []
    (Array.to_list (Sys.readdir preexisting))

let test_replaced_target_is_not_cleaned root =
  let source = claude_account root "native-source" in
  with_conversation source;
  native_pair root;
  let target = path root "native-target" in
  let moved = path root "original-created-target" in
  let replacement = ref None in
  let io =
    {
      (failing_io ()) with
      C.free_bytes =
        (fun actual ->
          Alcotest.(check string) "hook sees pinned actual target" target actual;
          Unix.rename target moved;
          Unix.mkdir target 0o700;
          replacement := Some (Unix.lstat target);
          Some 0);
    }
  in
  refused_with "carry_rollback_incomplete" (carry_named ~io root);
  (match !replacement with
  | None -> Alcotest.fail "target was not replaced"
  | Some identity -> check_identity "foreign empty replacement retained" identity target);
  Alcotest.(check (list string)) "foreign root still empty" []
    (Array.to_list (Sys.readdir target));
  Alcotest.(check bool) "original created root remains identifiable" true
    (exists (path moved C.lock_name))

let test_replaced_target_during_write_retains_recovery root =
  let source = claude_account root "native-source" in
  with_conversation source;
  native_pair root;
  let target = path root "native-target" in
  let moved = path root "original-writing-target" in
  let replacement = ref None in
  let io =
    {
      (failing_io ()) with
      C.write =
        (fun fd bytes offset length ->
          let written = Unix.write fd bytes offset length in
          if !replacement = None then begin
            Unix.rename target moved;
            Unix.mkdir target 0o700;
            replacement := Some (Unix.lstat target)
          end;
          written);
    }
  in
  let refusal = carry_named ~io root in
  refused_with "carry_rollback_incomplete" refusal;
  (match !replacement with
  | None -> Alcotest.fail "write hook did not replace target"
  | Some identity -> check_identity "replacement not removed by rollback" identity target);
  Alcotest.(check (list string)) "replacement receives no cleanup or writes" []
    (Array.to_list (Sys.readdir target));
  let temporaries =
    List.filter (fun relative -> contains relative ".carry-new-")
      (listing moved)
  in
  Alcotest.(check int) "uncertain temporary retained under original root" 1
    (List.length temporaries);
  List.iter
    (fun relative ->
      Alcotest.(check bool) "reports cleanup not attempted on replaced root" true
        (contains (message_of refusal) relative))
    temporaries;
  Alcotest.(check bool) "message has no absolute path" false
    (contains (message_of refusal) root)

let test_transient_root_check_reports_skipped_cleanup root =
  let source = claude_account root "native-source" in
  with_conversation source;
  let target = claude_account root "native-target" in
  let checks = ref 0 in
  let check_roots () =
    incr checks;
    if !checks = 1 || !checks >= 5 then Ok ()
    else Error { C.code = "account_folder_refused"; message = "changed" }
  in
  let refusal =
    Write.write_plan ~check_roots (writer_io (failing_io ~writes:0 ())) ~uid ~source
      ~target
      [ (transcript, (Unix.stat (path source transcript)).Unix.st_size, Write.Copy) ]
    |> expose_refusal
  in
  refused_with "carry_rollback_incomplete" refusal;
  let message = message_of refusal in
  let temporary =
    List.filter (fun name -> contains name ".carry-new-") (listing target)
  in
  Alcotest.(check int) "one staged copy left" 1 (List.length temporary);
  List.iter
    (fun name ->
      Alcotest.(check bool) "reports staged copy" true (contains message name))
    temporary;
  Alcotest.(check bool) "reports created folder" true
    (contains message project);
  Alcotest.(check bool) "no absolute paths" false (contains message root)

let test_transient_committed_cleanup_remains_reported root =
  let source = claude_account root "native-source" in
  let target = claude_account root "native-target" in
  write (path source "first.jsonl") "first\n";
  write (path source "second.jsonl") "second\n";
  let renames = ref 0 and checks = ref 0 in
  let io =
    {
      (failing_io ()) with
      C.rename =
        (fun before after ->
          incr renames;
          if !renames = 2 then
            raise (Unix.Unix_error (Unix.EIO, "rename", ""));
          Unix.rename before after);
    }
  in
  let check_roots () =
    incr checks;
    if !checks = 3 then
      Error { C.code = "account_folder_refused"; message = "changed" }
    else Ok ()
  in
  let refusal =
    Write.write_plan ~check_roots (writer_io io) ~uid ~source ~target
      [ ("first.jsonl", 6, Write.Copy); ("second.jsonl", 7, Write.Copy) ]
    |> expose_refusal
  in
  refused_with "carry_rollback_incomplete" refusal;
  Alcotest.(check bool) "first committed copy remains" true
    (exists (path target "first.jsonl"));
  Alcotest.(check bool) "skipped committed cleanup remains in the report" true
    (contains (message_of refusal) "first.jsonl");
  Alcotest.(check bool) "no absolute paths" false
    (contains (message_of refusal) root)

let test_failed_temporary_and_folder_cleanup_are_reported root =
  let source = claude_account root "native-source" in
  with_conversation source;
  let target = claude_account root "native-target" in
  let refusal =
    Write.write_plan (writer_io (failing_io ~writes:0 ~unlinks:0 ())) ~uid ~source
      ~target
      [ (transcript, (Unix.stat (path source transcript)).Unix.st_size, Write.Copy) ]
    |> expose_refusal
  in
  refused_with "carry_rollback_incomplete" refusal;
  let message = message_of refusal in
  let temporary =
    List.filter (fun name -> contains name ".carry-new-") (listing target)
  in
  Alcotest.(check int) "staged copy not unlinked" 1 (List.length temporary);
  List.iter
    (fun name ->
      Alcotest.(check bool) "reports failed unlink" true (contains message name))
    temporary;
  Alcotest.(check bool) "reports failed rmdir" true
    (contains message project);
  Alcotest.(check bool) "no absolute paths" false (contains message root)

let test_failed_folder_cleanup_without_temporary root =
  let source = claude_account root "native-source" in
  with_conversation source;
  let target = claude_account root "native-target" in
  let obstruction = path target (project ^ "/other-file") in
  let io : C.io =
    {
      (failing_io ()) with
      write =
        (fun _ _ _ _ ->
          write obstruction "do not remove";
          raise (Unix.Unix_error (Unix.EIO, "write", "")));
    }
  in
  let refusal =
    Write.write_plan (writer_io io) ~uid ~source ~target
      [ (transcript, (Unix.stat (path source transcript)).Unix.st_size, Write.Copy) ]
    |> expose_refusal
  in
  refused_with "carry_rollback_incomplete" refusal;
  let message = message_of refusal in
  Alcotest.(check bool) "reports rmdir failure" true
    (contains message project);
  Alcotest.(check bool) "no staged copy left" false
    (List.exists (fun name -> contains name ".carry-new-") (listing target));
  Alcotest.(check bool) "unrelated entry untouched" true (exists obstruction);
  Alcotest.(check bool) "no absolute paths" false (contains message root)

type rename_transition =
  | Copy_installed
  | Backup_moved
  | Replacement_installed
  | Backup_restored
  | Prior_replacement_committed

let test_rename_transition transition root =
  let source = claude_account root "native-source" in
  with_conversation source;
  let target = claude_account root "native-target" in
  native_pair root;
  let replacing = transition <> Copy_installed in
  let older = "{\"line\":1}\n" in
  if replacing then write (path target transcript) older;
  let moved = path root "original-target" in
  let backup = ref None and temporary = ref None and last_final = ref None in
  let replacement = ref None in
  let relative full =
    String.sub full (String.length target + 1)
      (String.length full - String.length target - 1)
  in
  let swap () =
    Unix.rename target moved;
    Unix.mkdir target 0o700;
    write (path target "foreign.txt") "untouched";
    replacement := Some (Unix.lstat target)
  in
  let io =
    {
      (failing_io ()) with
      C.rename =
        (fun before after ->
          let staged = contains before ".carry-new-" in
          let restoring = contains before ".carry-old-" in
          if contains after ".carry-old-" then backup := Some (relative after);
          if staged then begin
            temporary := Some (relative before);
            last_final := Some (relative after)
          end;
          if transition = Backup_restored && staged then
            raise (Unix.Unix_error (Unix.EIO, "rename", ""));
          Unix.rename before after;
          let hit =
            match transition with
            | Copy_installed | Replacement_installed ->
                staged && relative after = transcript
            | Backup_moved -> contains after ".carry-old-"
            | Backup_restored -> restoring
            | Prior_replacement_committed ->
                staged && relative after <> transcript
          in
          if hit then swap ());
    }
  in
  let refusal = carry_named ~io root in
  refused_with "carry_rollback_incomplete" refusal;
  (match !replacement with
  | None -> Alcotest.fail "the rename hook did not replace the root"
  | Some identity ->
      check_identity "foreign root retained" identity target);
  Alcotest.(check (list string)) "foreign root untouched" [ "foreign.txt" ]
    (Array.to_list (Sys.readdir target));
  Alcotest.(check string) "foreign marker retained" "untouched"
    (read (path target "foreign.txt"));
  let message = message_of refusal in
  let expected =
    transcript :: List.filter_map Fun.id [ !backup; !temporary; !last_final ]
  in
  List.iter
    (fun candidate ->
      Alcotest.(check bool) ("reports " ^ candidate) true
        (contains message candidate))
    expected;
  Alcotest.(check bool) "no absolute path in report" false
    (contains message root);
  let original_entries = listing moved in
  (match transition with
  | Copy_installed | Replacement_installed | Prior_replacement_committed ->
      Alcotest.(check bool) "installed copy retained for review" true
        (exists (path moved transcript))
  | Backup_moved ->
      Alcotest.(check bool) "older backup retained for review" true
        (List.exists (fun name -> contains name ".carry-old-") original_entries)
  | Backup_restored ->
      Alcotest.(check string) "older copy restored, not deleted" older
        (read (path moved transcript)));
  if transition = Prior_replacement_committed then
    (match !backup with
    | None -> Alcotest.fail "prior committed replacement lacks its backup"
    | Some relative ->
        Alcotest.(check bool) "prior committed backup retained" true
          (exists (path moved relative)))

let test_backup_cleanup_root_swap root =
  let source = claude_account root "native-source" in
  with_conversation source;
  let target = claude_account root "native-target" in
  native_pair root;
  write (path target transcript) "{\"line\":1}\n";
  let moved = path root "original-target" in
  let backup = ref None in
  let io =
    {
      (failing_io ()) with
      C.unlink =
        (fun name ->
          Unix.unlink name;
          if contains name ".carry-old-" then begin
            backup :=
              Some
                (String.sub name (String.length target + 1)
                   (String.length name - String.length target - 1));
            Unix.rename target moved;
            Unix.mkdir target 0o700;
            write (path target "foreign.txt") "untouched"
          end);
    }
  in
  let refusal = carry_named ~io root in
  refused_with "carry_rollback_incomplete" refusal;
  let message = message_of refusal in
  Alcotest.(check bool) "installed file reported" true
    (contains message transcript);
  (match !backup with
  | None -> Alcotest.fail "backup cleanup hook did not run"
  | Some name ->
      Alcotest.(check bool) "backup transition reported" true
        (contains message name));
  Alcotest.(check bool) "no absolute paths" false (contains message root);
  Alcotest.(check (list string)) "foreign root never cleaned" [ "foreign.txt" ]
    (Array.to_list (Sys.readdir target));
  Alcotest.(check string) "installed original kept for review"
    (read (path source transcript)) (read (path moved transcript))

let test_backup_cleanup_failure root =
  let source = claude_account root "native-source" in
  with_conversation source;
  let target = claude_account root "native-target" in
  native_pair root;
  write (path target transcript) "{\"line\":1}\n";
  let io =
    {
      (failing_io ()) with
      C.unlink =
        (fun name ->
          if contains name ".carry-old-" then
            raise (Unix.Unix_error (Unix.EIO, "unlink", ""))
          else Unix.unlink name);
    }
  in
  let refusal = carry_named ~io root in
  refused_with "carry_rollback_incomplete" refusal;
  let message = message_of refusal in
  Alcotest.(check bool) "installed final reported" true
    (contains message transcript);
  let backups =
    List.filter (fun name -> contains name ".carry-old-") (listing target)
  in
  Alcotest.(check int) "backup was not discarded" 1 (List.length backups);
  List.iter
    (fun name ->
      Alcotest.(check bool) "backup reported" true (contains message name))
    backups;
  Alcotest.(check bool) "no absolute paths" false (contains message root)

(* Exercise the private functional binding seam, not a public IO test hook or
   process-wide descriptor exhaustion. The real binder maps open errors such
   as EMFILE to a refusal before invoking the carry callback. *)
let test_target_bind_failure_cleanup root =
  let module Target = Mesh_accounts_carry__Carry_target in
  let run name ~created ~replace ~enter =
    let target = path root name in
    Unix.mkdir target 0o700;
    let identity = Unix.lstat target in
    let entered = ref false in
    let replacement = ref None in
    let bind callback =
      if replace then begin
        Unix.rename target (path root (name ^ "-original"));
        Unix.mkdir target 0o700;
        replacement := Some (Unix.lstat target)
      end;
      if enter then callback identity else Error "EMFILE"
    in
    let result =
      Target.with_target_binding ~target ~created ~identity bind (fun _ ->
          entered := true;
          Error "callback refusal")
    in
    Alcotest.(check (result unit string))
      "original refusal preserved"
      (Error (if enter then "callback refusal" else "EMFILE"))
      result;
    Alcotest.(check bool) "callback boundary" enter !entered;
    Alcotest.(check bool)
      name
      ((not created) || replace || enter)
      (exists target);
    match !replacement with
    | Some replacement ->
        check_identity "foreign replacement identity retained" replacement
          target;
        Alcotest.(check (list string))
          "foreign replacement left empty" []
          (Array.to_list (Sys.readdir target))
    | None ->
        if (not created) || enter then
          check_identity "pre-existing or entered directory retained" identity
            target
  in
  run "created-bind-failure" ~created:true ~replace:false ~enter:false;
  run "preexisting-bind-failure" ~created:false ~replace:false ~enter:false;
  run "replaced-bind-failure" ~created:true ~replace:true ~enter:false;
  run "callback-handles-own-cleanup" ~created:true ~replace:false ~enter:true;
  let target = path root "raised-bind-failure" in
  Unix.mkdir target 0o700;
  let identity = Unix.lstat target in
  let caught =
    try
      ignore
        (Target.with_target_binding ~target ~created:true ~identity
           (fun _ -> raise (Unix.Unix_error (Unix.EMFILE, "open", "")))
           (fun _ -> Alcotest.fail "callback entered after failed open"));
      false
    with Unix.Unix_error (Unix.EMFILE, _, _) -> true
  in
  Alcotest.(check bool) "binding exception preserved" true caught;
  Alcotest.(check bool)
    "raised pre-callback failure removes own empty root" false (exists target)

let test_created_cleanup_uses_original_identity root =
  let module Target = Mesh_accounts_carry__Carry_target in
  let target = path root "new-target" in
  let moved = path root "original-target" in
  Unix.mkdir target 0o700;
  let before = Unix.lstat target in
  Unix.rename target moved;
  Unix.mkdir target 0o700;
  let bound = Unix.lstat target in
  Target.remove_empty_created ~target ~identity:before;
  check_identity "replacement must not be removed" bound target;
  check_identity "original remains elsewhere" before moved;
  Unix.rmdir target;
  Unix.rename moved target;
  Target.remove_empty_created ~target ~identity:before;
  Alcotest.(check bool) "still-identical exclusive root removed" false
    (exists target)

let () =
  Alcotest.run "native registry carry convergence"
    [
      ( "source and transactions",
        List.map
          (fun (name, test) ->
            Alcotest.test_case name `Quick (with_native_root test))
          [
            ("bound pair revisions", test_expected_pair_revisions);
            ("migrated actual Claude/Codex carry", test_migrated_actual_carry);
            ("malformed and symlink registry never fall back", test_malformed_never_falls_back);
            ("disabled accounts refuse", test_disabled_named_accounts);
            ("missing source is never prepared", test_missing_source_not_prepared);
             ("created target rollback and success retention", test_created_target_rollback);
             ("unproven target creation cannot authorize cleanup", test_unproven_target_creation_is_not_cleanup_authority);
             ("unproven child creation cannot authorize cleanup", test_unproven_child_creation_is_not_cleanup_authority);
             ("injected proven custody retains safe empty cleanup", test_injected_proven_custody_still_cleans_empty_folder);
            ("existing target failure retention", test_existing_target_retention);
            ("explicit default remains source-independent", test_explicit_default_without_registry);
            ("one snapshot precedes both folder lookups", test_one_snapshot_before_folder_lookup);
            ("registry edit during copy stays pinned", test_registry_change_during_copy_stays_pinned);
            ("default target environment is pinned", test_default_target_environment_is_pinned);
            ("replacement target is not cleaned", test_replaced_target_is_not_cleaned);
            ("replacement during write retains recovery", test_replaced_target_during_write_retains_recovery);
             ("transient root check reports skipped cleanup", test_transient_root_check_reports_skipped_cleanup);
             ("transient committed cleanup remains reported", test_transient_committed_cleanup_remains_reported);
            ("failed staged unlink and rmdir are reported", test_failed_temporary_and_folder_cleanup_are_reported);
            ("failed rmdir without staged leftovers", test_failed_folder_cleanup_without_temporary);
            ("copy rename changes root after install", test_rename_transition Copy_installed);
            ("replace rename changes root after backup", test_rename_transition Backup_moved);
            ("replace rename changes root after install", test_rename_transition Replacement_installed);
            ("restore rename changes root after restore", test_rename_transition Backup_restored);
            ("prior committed backup reported after root change", test_rename_transition Prior_replacement_committed);
            ("backup cleanup root swap reports transition", test_backup_cleanup_root_swap);
            ("backup cleanup failure remains reportable", test_backup_cleanup_failure);
            ("target bind failure cleanup", test_target_bind_failure_cleanup);
            ("created cleanup uses original identity", test_created_cleanup_uses_original_identity);
          ] );
    ]
