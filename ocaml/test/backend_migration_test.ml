(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

module P = Mesh_backend_profile
module M = Backend_migration_impl

let helper = Sys.argv.(1)
let s x = `String x
let source root = Filename.concat root "accounts.json"
let target root = Filename.concat root "backend-profiles.json"
let marker root = Filename.concat root "backend-profiles.migrated"
let intent root = Filename.concat root ".backend-profiles.migration-intent"
let migration_lock root = Filename.concat root ".backend-profiles.lock"
let legacy_switch_marker root = Filename.concat root ".backend-profiles.legacy-switch"

let write path bytes =
  Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_excl ] 0o600 path
    (fun channel -> output_string channel bytes)

let read path = In_channel.with_open_bin path In_channel.input_all

let recover_provision root =
  let expected = match M.inspect_provision ~root with Ok proof -> proof | Error code -> Alcotest.fail code in
  M.recover_provision ~root ~expected

let record_intent root stage original content =
  let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
      ignore
        (M.write_intent ~root ~directory
           (M.intent_bytes ~stage
              ~source_identity:(Unix.lstat (source root))
              ~source_bytes:original
              ~target_identity:(Unix.lstat stage) content)))

let rec cleanup path =
  match (Unix.lstat path).Unix.st_kind with
  | Unix.S_DIR ->
      Unix.chmod path 0o700;
      Array.iter
        (fun name -> cleanup (Filename.concat path name))
        (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path

let fixture f =
  let root = Test_scratch.private_directory "backend-migration-" in
  Fun.protect ~finally:(fun () -> cleanup root) (fun () -> f root)

let account ?(label = "Work") ?claude ?codex id =
  `Assoc
    ([ ("id", s id); ("label", s label) ]
    @ Option.fold ~none:[]
        ~some:(fun p -> [ ("claude_config_dir", s p) ])
        claude
    @ Option.fold ~none:[] ~some:(fun p -> [ ("codex_home", s p) ]) codex)

let legacy rows =
  Yojson.Safe.to_string (`Assoc [ ("v", `Int 1); ("accounts", `List rows) ])

let start root arguments =
  let input = Unix.openfile "/dev/null" [ Unix.O_RDONLY ] 0 in
  let output, child_output = Unix.pipe ~cloexec:true () in
  let pid =
    Unix.create_process_env helper
      (Array.of_list (helper :: arguments))
      [| "PATH=/usr/bin:/bin"; "HOME=" ^ root; "MESH_CONF_DIR=" ^ root |]
      input child_output child_output
  in
  Unix.close input;
  Unix.close child_output;
  (pid, output)

let finish (pid, output) =
  let channel = Unix.in_channel_of_descr output in
  let bytes =
    Fun.protect
      ~finally:(fun () -> close_in channel)
      (fun () -> In_channel.input_all channel)
  in
  let _, status = Unix.waitpid [] pid in
  (status, Yojson.Safe.from_string bytes)

let run root args = finish (start root args)

let success root aliases profiles =
  let status, response = run root [ "migrate" ] in
  Alcotest.(check bool) "exit zero" true (status = Unix.WEXITED 0);
  Alcotest.(check string)
    "counts only"
    (Yojson.Safe.to_string
       (`Assoc
          [
            ("version", `Int 1);
            ("ok", `Bool true);
            ( "data",
              `Assoc [ ("aliases", `Int aliases); ("profiles", `Int profiles) ]
            );
          ]))
    (Yojson.Safe.to_string response)

let refusal root code =
  let status, response = run root [ "migrate" ] in
  Alcotest.(check bool) "exit one" true (status = Unix.WEXITED 1);
  Alcotest.(check string)
    "fixed path-free error"
    (Yojson.Safe.to_string
       (`Assoc [ ("version", `Int 1); ("ok", `Bool false); ("code", s code) ]))
    (Yojson.Safe.to_string response)

let no_target root =
  Alcotest.(check bool)
    "no partial output" false
    (Sys.file_exists (target root));
  Alcotest.(check bool)
    "no premature retirement marker" false
    (Sys.file_exists (marker root));
  Alcotest.(check bool)
    "no premature publication intent" false
    (Sys.file_exists (intent root));
  Alcotest.(check bool)
    "no staging file" false
    (Array.exists
       (String.starts_with ~prefix:".backend-profiles-")
       (Sys.readdir root))

let dual_backend () =
  fixture (fun root ->
      let claude = Filename.concat root "claude"
      and codex = Filename.concat root "codex" in
      Unix.mkdir claude 0o700;
      Unix.mkdir codex 0o700;
      let credentials = Filename.concat claude "private-fixture" in
      write credentials "private fixture, never copied";
      let original = legacy [ account ~label:" Work " ~claude ~codex "work" ] in
      write (source root) original;
       let source_identity = Unix.lstat (source root) in
       success root 1 2;
       let lock_identity = Unix.lstat (migration_lock root) in
       Alcotest.(check bool) "private persistent lock" true
         (M.private_file lock_identity);
      Alcotest.(check string)
        "source byte unchanged" original
        (read (source root));
      Alcotest.(check bool)
        "legacy file identity unchanged" true
        (M.same source_identity (Unix.lstat (source root)));
      Alcotest.(check int)
        "private target" 0o600
        ((Unix.stat (target root)).Unix.st_perm land 0o777);
      Alcotest.(check int)
        "one target link" 1 (Unix.stat (target root)).Unix.st_nlink;
      let registry =
        match P.load ~root with
        | Ok (Some r) -> r
        | _ -> Alcotest.fail "valid private registry expected"
      in
      let retired = Unix.lstat (marker root) in
      Alcotest.(check bool)
        "retirement marker private" true (M.private_file retired);
      Alcotest.(check int)
        "retirement marker mode" 0o600
        (retired.Unix.st_perm land 0o777);
      Alcotest.(check int)
        "retirement marker owner" (Unix.geteuid ()) retired.Unix.st_uid;
      Alcotest.(check int)
        "retirement marker single link" 1 retired.Unix.st_nlink;
      let marker_bytes = read (marker root) in
      Alcotest.(check bool)
        "retirement marker path-free" false
        (String.contains marker_bytes '/');
      Alcotest.(check string)
        "marker binds exact registry bytes"
        (Yojson.Safe.to_string
           (`Assoc
              [
                ("version", `Int 1);
                ("registry_revision", s (P.registry_revision registry));
              ])
        ^ "\n")
        marker_bytes;
      List.iter
        (fun (backend, config, role, suffix) ->
          let p =
            match
              P.resolve registry ~id:"work" ~backend ~expected_context:None
            with
            | Ok p -> p
            | Error _ -> Alcotest.fail "backend-qualified work expected"
          in
          Alcotest.(check string) "trimmed alias label" "Work" (P.label p);
          Alcotest.(check bool) "enabled" true (P.enabled p);
          Alcotest.(check string)
            "config unchanged" config
            (List.assoc "config" (P.roots p));
          Alcotest.(check string)
            "conventional subtree"
            (Filename.concat config suffix)
            (List.assoc role (P.roots p));
          Alcotest.(check bool)
            "switch remains unqualified" true
            (Yojson.Safe.Util.member "switch_qualified" (P.public_json p)
            = `Bool false);
          Alcotest.(check bool)
            "no history created" false
            (Sys.file_exists (Filename.concat config suffix)))
        [
          (P.Claude, claude, "history", "projects");
          (P.Codex, codex, "state", "sessions");
        ];
      Alcotest.(check string)
        "credentials untouched" "private fixture, never copied"
        (read credentials);
      let published = read (target root) in
       refusal root "migration-target-exists";
       Alcotest.(check bool) "repeat retains lock inode" true
         (M.same lock_identity (Unix.lstat (migration_lock root)));
      Alcotest.(check string)
        "repeat cannot overwrite" published
        (read (target root));
      Unix.unlink (target root);
      refusal root "migration-already-retired";
      Alcotest.(check bool)
        "removing registry alone cannot remigrate" false
        (Sys.file_exists (target root));
      Alcotest.(check string)
        "retirement remains intact" marker_bytes
        (read (marker root));
      Alcotest.(check string)
        "retired legacy source unchanged" original
        (read (source root)))

let missing_agent_roots () =
  fixture (fun root ->
      let claude = Filename.concat root "not-created" in
      write (source root) (legacy [ account ~claude "work" ]);
      success root 1 1;
      Alcotest.(check bool)
        "missing root is not created" false (Sys.file_exists claude))

let unicode () =
  fixture (fun root ->
      let label = String.concat "" (List.init 24 (fun _ -> "界")) in
      write (source root)
        (legacy
           [ account ~label ~claude:(Filename.concat root "claude") "work" ]);
      success root 1 1)

let invalid_sources () =
  let cases root =
    let path = Filename.concat root "claude" in
    let good = account ~claude:path "work" in
    [
      "{}";
      "not json";
      "{\"v\":1,\"v\":1,\"accounts\":[]}";
      legacy
        [
          `Assoc
            [
              ("id", s "work");
              ("label", s "Work");
              ("claude_config_dir", s path);
              ("secret", s "no");
            ];
        ];
      legacy [ account ~label:(String.make 25 'x') ~claude:path "work" ];
      legacy
        [
          account
            ~label:(String.concat "" (List.init 25 (fun _ -> "界")))
            ~claude:path "work";
        ];
      legacy [ account ~label:"bad\226\128\139label" ~claude:path "work" ];
      legacy [ good; account ~label:"Other" ~claude:path "other" ];
      legacy [ account ~claude:"/bad/../path" "work" ];
      legacy [ account ~claude:path "default" ];
    ]
  in
  fixture (fun root ->
      List.iter
        (fun bytes ->
          write (source root) bytes;
          refusal root "migration-invalid-source";
          no_target root;
          Alcotest.(check string)
            "invalid source untouched" bytes
            (read (source root));
          Unix.unlink (source root))
        (cases root))

let invalid_conversion () =
  fixture (fun root ->
      let claude = Filename.concat root "claude" in
      write (source root)
        (legacy
           [
             account ~claude "work";
             account ~label:"Other"
               ~codex:(Filename.concat claude "nested")
               "other";
           ]);
      refusal root "migration-invalid-profiles";
      no_target root;
      Unix.unlink (source root);
      write (source root)
        (legacy
           [
             account ~claude "work";
             account ~label:" Work "
               ~claude:(Filename.concat root "other")
               "other";
           ]);
      refusal root "migration-invalid-profiles";
      no_target root)

let trimmed_name_collision () =
  fixture (fun root ->
      let original =
        legacy
          [
            account ~label:"Office" ~claude:(Filename.concat root "one")
              "work";
            account ~label:" work " ~claude:(Filename.concat root "two")
              "other";
          ]
      in
      write (source root) original;
      refusal root "migration-profile-name-collision";
      no_target root;
      Alcotest.(check string) "legacy source untouched" original
        (read (source root)));
  fixture (fun root ->
      write (source root)
        (legacy
           [
             account ~label:" default "
               ~codex:(Filename.concat root "codex")
               "other";
           ]);
      refusal root "migration-profile-name-collision";
      no_target root);
  fixture (fun root ->
      write (source root)
        (legacy
           [
             account ~label:"Office" ~claude:(Filename.concat root "one") "work";
             account ~label:" work " ~codex:(Filename.concat root "two") "other";
           ]);
      success root 2 2)

let derived_root_limit () =
  let long_base root length =
    let rec extend parent =
      let remaining = length - String.length parent - 1 in
      if remaining <= 100 then
        Filename.concat parent (String.make remaining 'a')
      else
        let next = Filename.concat parent (String.make 100 'a') in
        Unix.mkdir next 0o700;
        extend next
    in
    extend root
  in
  List.iter
    (fun backend ->
      fixture (fun root ->
          let base = long_base root 1024 in
          Alcotest.(check bool) "legacy base valid" true
            (Mesh_accounts.valid_path base);
          write (source root)
            (legacy
               [
                 (if backend = `Claude then account ~claude:base "work"
                  else account ~codex:base "work");
               ]);
          refusal root "migration-derived-root-too-long";
          no_target root);
      fixture (fun root ->
          let suffix = if backend = `Claude then "projects" else "sessions" in
          let base = long_base root (1024 - 1 - String.length suffix) in
          write (source root)
            (legacy
               [
                 (if backend = `Claude then account ~claude:base "work"
                  else account ~codex:base "work");
               ]);
          success root 1 1))
    [ `Claude; `Codex ]

let interrupted_link () =
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
      write stage content;
      record_intent root stage original content;
      Unix.link stage (target root);
      success root 0 0;
      Alcotest.(check bool) "recorded stage cleaned" false (Sys.file_exists stage);
      Alcotest.(check bool) "record retired" false (Sys.file_exists (intent root));
      Alcotest.(check bool) "marker published" true (Sys.file_exists (marker root)));
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
      write stage content;
      record_intent root stage original content;
      Unix.link stage (target root);
      Unix.unlink stage;
      success root 0 0;
      Alcotest.(check bool) "single-link crash record retired" false
        (Sys.file_exists (intent root)));
  fixture (fun root ->
      let config = Filename.concat root "claude" in
      let original = legacy [ account ~claude:config "work" ] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
      write stage content;
      Unix.link stage (target root);
      Alcotest.(check int) "interrupted hard link" 2
        (Unix.lstat (target root)).Unix.st_nlink;
      refusal root "migration-target-exists";
      Alcotest.(check bool) "foreign matching stage retained" true
        (Sys.file_exists stage);
      Alcotest.(check bool) "no marker for foreign matching bytes" false
        (Sys.file_exists (marker root));
      Alcotest.(check string) "source untouched" original (read (source root)));
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
      write stage "foreign same-user bytes";
      Unix.link stage (target root);
      refusal root "migration-target-exists";
      Alcotest.(check string) "foreign link intact" "foreign same-user bytes"
        (read stage);
      Alcotest.(check int) "foreign nlink intact" 2
        (Unix.lstat (target root)).Unix.st_nlink);
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let foreign = Filename.concat root "foreign" in
      write foreign content;
      Unix.link foreign (target root);
      refusal root "migration-target-exists";
      Alcotest.(check bool) "unrecognized sibling remains" true
        (Sys.file_exists foreign));
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
      write stage content;
      Unix.link stage (target root);
      record_intent root stage original content;
      Unix.unlink (source root);
      write (source root)
        (legacy [ account ~claude:(Filename.concat root "other") "work" ]);
      refusal root "migration-target-exists";
      Alcotest.(check int) "stale stage not removed" 2
        (Unix.lstat stage).Unix.st_nlink;
      Alcotest.(check bool) "no retirement" false (Sys.file_exists (marker root)));
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
      write stage content;
      record_intent root stage original content;
      Unix.link stage (target root);
      let fd = Unix.openfile (source root) [ Unix.O_WRONLY; Unix.O_TRUNC ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
          M.write_all fd
            (legacy [ account ~claude:(Filename.concat root "new") "work" ])
            0);
      refusal root "migration-target-exists";
      Alcotest.(check int) "changed source inode remains untouched" 2
        (Unix.lstat stage).Unix.st_nlink);
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
      write stage content;
      record_intent root stage original content;
      Unix.link stage (target root);
      write (marker root) "foreign marker";
      refusal root "migration-target-exists";
      Alcotest.(check string) "marker not overwritten" "foreign marker"
        (read (marker root));
      Alcotest.(check int) "stage not unlinked after marker refusal" 2
        (Unix.lstat stage).Unix.st_nlink);
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
      write stage content;
      record_intent root stage original content;
      Unix.link stage (target root);
      let bytes = read (intent root) in
      Unix.unlink (intent root);
      write (intent root) (bytes ^ "tampered");
      refusal root "migration-target-exists";
      Alcotest.(check int) "tampered record leaves both links" 2
        (Unix.lstat stage).Unix.st_nlink);
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
       write stage content;
       record_intent root stage original content;
       let old_inode = Unix.openfile stage [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
       Fun.protect ~finally:(fun () -> Unix.close old_inode) (fun () ->
           let original_identity = Unix.fstat old_inode in
           Unix.unlink stage;
           write stage content;
           let replacement = Unix.lstat stage in
           Alcotest.(check bool) "replacement inode differs while old is pinned"
             false (M.same original_identity replacement);
           Unix.link stage (target root);
           refusal root "migration-target-exists";
           Alcotest.(check int) "recorded wrong inode never cleaned" 2
             (Unix.lstat stage).Unix.st_nlink));
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage = Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp" in
      write stage content;
      record_intent root stage original content;
      refusal root "migration-target-exists";
      Alcotest.(check bool) "prelink intent retained for operator" true
        (Sys.file_exists (intent root));
      Alcotest.(check bool) "no target created behind stale intent" false
        (Sys.file_exists (target root)));
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
      write stage content;
      Unix.link stage (target root);
      record_intent root stage original content;
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Unix.close directory;
      Alcotest.(check bool) "failed post-unlink sync is uncertain" true
        (M.recover_link ~root ~directory ~before_publish:(fun () -> Ok ())
           ~source_identity:(Unix.lstat (source root)) ~source_bytes:original
           content
        = Error M.Publication_uncertain);
      Alcotest.(check int) "recorded target single link" 1
        (Unix.lstat (target root)).Unix.st_nlink;
      success root 0 0;
      Alcotest.(check bool) "record removed on recovery" false
        (Sys.file_exists (intent root)));
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let stage =
        Filename.concat root ".backend-profiles-123-1234abcd1234abcd.tmp"
      in
      write stage content;
      Unix.link stage (target root);
      record_intent root stage original content;
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect
        ~finally:(fun () -> Unix.close directory)
        (fun () ->
          Alcotest.(check bool) "replaced stage refused" true
            (M.recover_link ~root ~directory
               ~before_publish:(fun () ->
                 Unix.unlink stage;
                 write stage "foreign replacement";
                 Ok ())
               ~source_identity:(Unix.lstat (source root))
               ~source_bytes:original content
            = Error M.Target_exists);
          Alcotest.(check string) "replacement untouched" "foreign replacement"
            (read stage);
          Alcotest.(check string) "target untouched" content (read (target root))))

let custody () =
  fixture (fun root ->
      let bytes =
        legacy [ account ~claude:(Filename.concat root "claude") "work" ]
      in
      refusal root "migration-source-missing";
      write (source root) bytes;
      List.iter
        (fun mode ->
          Unix.chmod (source root) mode;
          refusal root "migration-unsafe-source";
          no_target root)
        [ 0o644; 0o660; 0o666 ];
      Unix.chmod (source root) 0o600;
      let other = Filename.concat root "other" in
      Unix.rename (source root) other;
      Unix.symlink other (source root);
      refusal root "migration-unsafe-source";
      Unix.unlink (source root);
      Unix.link other (source root);
      refusal root "migration-unsafe-source";
      Unix.unlink (source root);
      Unix.rename other (source root);
      Unix.chmod root 0o755;
      refusal root "migration-unsafe-configuration-root";
      Unix.chmod root 0o700;
      no_target root)

let unsafe_agent_roots () =
  fixture (fun root ->
      let config = Filename.concat root "claude" in
      Unix.mkdir config 0o700;
      write (source root) (legacy [ account ~claude:config "work" ]);
      let history = Filename.concat config "projects" in
      Unix.symlink config history;
      refusal root "migration-unsafe-agent-roots";
      no_target root;
      Unix.unlink history;
      Unix.chmod config 0o777;
      refusal root "migration-unsafe-agent-roots";
      no_target root;
      Unix.chmod config 0o700;
      Unix.rmdir config;
      let actual = Filename.concat root "actual" in
      Unix.mkdir actual 0o700;
      Unix.symlink actual config;
      refusal root "migration-unsafe-agent-roots";
      no_target root)

let existing_targets () =
  fixture (fun root ->
      write (source root) (legacy []);
      write (target root) "foreign bytes";
      refusal root "migration-target-exists";
      Alcotest.(check string)
        "foreign target untouched" "foreign bytes"
        (read (target root));
      let other = Filename.concat root "other" in
      Unix.rename (target root) other;
      Unix.symlink other (target root);
      refusal root "migration-target-exists";
      Unix.unlink (target root);
      Unix.link other (target root);
      refusal root "migration-target-exists";
      Unix.unlink (target root);
      Unix.mkdir (target root) 0o700;
      refusal root "migration-target-exists")

let capacity () =
  fixture (fun root ->
      let rows dual =
        List.init 64 (fun i ->
            let id = "a" ^ string_of_int i in
            account ~label:id
              ~claude:(Filename.concat root (id ^ "-claude"))
              ?codex:
                (if dual then Some (Filename.concat root (id ^ "-codex"))
                 else None)
              id)
      in
      write (source root) (legacy (rows true));
      success root 64 128;
      let bytes = read (target root) in
      let registry =
        match P.of_string bytes with
        | Ok r -> r
        | _ -> Alcotest.fail "128 profiles expected"
      in
      Alcotest.(check int)
        "all legacy backend identities preserved" 128
        (List.length (P.profiles registry));
      Unix.unlink (target root);
      (* This second private fixture run deliberately performs manual rollback. *)
      Unix.unlink (marker root);
      Unix.unlink (source root);
      write (source root) (legacy (rows false));
      success root 64 64)

let concurrent () =
  let total_busy = ref 0 and total_existing = ref 0 in
  for iteration = 1 to 20 do
    fixture (fun root ->
      let original =
        legacy [ account ~claude:(Filename.concat root "claude") "work" ]
      in
      write (source root) original;
      let workers = List.init 8 (fun _ -> start root [ "migrate" ]) in
      let results = List.map finish workers in
      Alcotest.(check int)
        "one winning writer" 1
        (List.length
           (List.filter (fun (status, _) -> status = Unix.WEXITED 0) results));
      List.iter
        (fun (status, response) ->
          if status <> Unix.WEXITED 0 then (
            Alcotest.(check bool) "loser exited with refusal" true
              (status = Unix.WEXITED 1);
            let code = Yojson.Safe.Util.member "code" response in
            if code = s "migration-target-exists" then incr total_existing
            else if code = s "migration-busy" then incr total_busy
            else
              Alcotest.failf "iteration %d: unexpected losing result %s"
                iteration (Yojson.Safe.to_string response)))
        results;
      Alcotest.(check string)
        "source unchanged under concurrency" original
        (read (source root));
      Alcotest.(check bool)
        "complete valid target" true
        (Result.is_ok (P.load ~root));
      Alcotest.(check int)
        "target has no staging link" 1 (Unix.stat (target root)).Unix.st_nlink;
      Alcotest.(check (list string))
        "only source, target, marker and persistent lock"
        [
          ".backend-profiles.lock";
          "accounts.json";
          "backend-profiles.json";
          "backend-profiles.migrated";
        ]
        (Array.to_list (Sys.readdir root) |> List.sort String.compare))
  done;
  Alcotest.(check int) "twenty rounds, seven refused per round" 140
    (!total_busy + !total_existing);
  Printf.printf "20 rounds: 20 winners, %d busy, %d existing target\n%!"
    !total_busy !total_existing

let live_publication () =
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok converted -> converted
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let ready_read, ready_write = Unix.pipe ~cloexec:true () in
      let release_read, release_write = Unix.pipe ~cloexec:true () in
      let child = Unix.fork () in
      if child = 0 then (
        Unix.close ready_read;
        Unix.close release_write;
        let status =
          try
            let result =
              M.with_migration_lock ~root (fun () ->
                  let directory =
                    Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0
                  in
                  Fun.protect ~finally:(fun () -> Unix.close directory)
                    (fun () ->
                      let stage =
                        Filename.concat root
                          ".backend-profiles-123-1234abcd1234abcd.tmp"
                      in
                      write stage content;
                      record_intent root stage original content;
                      Unix.link stage (target root);
                      let signal = Bytes.of_string "1" in
                      ignore (Unix.write ready_write signal 0 1);
                      let received = Bytes.create 1 in
                      if Unix.read release_read received 0 1 <> 1 then
                        Error M.Publication_failed
                      else (
                        Unix.unlink stage;
                        Unix.fsync directory;
                        Result.bind
                          (M.publish_marker ~root ~directory
                             ~before_publish:(fun () -> Ok ()) content)
                          (fun () ->
                            M.finish_intent ~root ~directory
                              ~source_identity:(Unix.lstat (source root))
                              ~source_bytes:original content))))
            in
            if result = Ok () then 0 else 1
          with _ -> 2
        in
        Unix.close ready_write;
        Unix.close release_read;
        Unix._exit status);
      Unix.close ready_write;
      Unix.close release_read;
      let child_status = ref None in
      Fun.protect
        ~finally:(fun () ->
          Unix.close ready_read;
          (try ignore (Unix.write release_write (Bytes.of_string "1") 0 1)
           with Unix.Unix_error (Unix.EPIPE, _, _) -> ());
          Unix.close release_write;
          child_status := Some (Unix.waitpid [] child))
        (fun () ->
          let ready = Bytes.create 1 in
          Alcotest.(check int) "live link reached" 1
            (Unix.read ready_read ready 0 1);
          let before = read (intent root) in
          refusal root "migration-busy";
          Alcotest.(check int) "live stage still linked" 2
            (Unix.lstat (target root)).Unix.st_nlink;
          Alcotest.(check string) "live intent unchanged" before
            (read (intent root));
          Alcotest.(check string) "source unchanged" original
            (read (source root));
          Alcotest.(check bool) "marker not stolen" false
            (Sys.file_exists (marker root)));
      Alcotest.(check bool) "publisher finished" true
        (match !child_status with
        | Some (_, Unix.WEXITED 0) -> true
        | _ -> false);
      Alcotest.(check int) "linked target cleaned" 1
        (Unix.lstat (target root)).Unix.st_nlink;
      Alcotest.(check bool) "publisher retired marker" true
        (Sys.file_exists (marker root));
      Alcotest.(check bool) "lock file remains stable" true
        (M.private_file (Unix.lstat (migration_lock root))))

let legacy_switch_crash_keeps_migration_blocked () =
  fixture (fun root ->
    write (source root) (legacy []);
    let ready_read, ready_write = Unix.pipe ~cloexec:true () in
    let child = Unix.fork () in
    if child = 0 then (
      Unix.close ready_read;
      let status =
        try
          match M.with_migration_lock ~root (fun () ->
            write (legacy_switch_marker root) "private switch receipt";
            let fd = Unix.openfile (legacy_switch_marker root) [Unix.O_RDONLY] 0 in
            Unix.fsync fd;
            Unix.close fd;
            let dir = Unix.openfile root [Unix.O_RDONLY] 0 in
            Unix.fsync dir;
            Unix.close dir;
            ignore (Unix.write_substring ready_write "1" 0 1);
            while true do Unix.pause () done;
            Ok ()) with
          | Ok () -> 0 | Error _ -> 1
        with _ -> 2
      in Unix._exit status);
    Unix.close ready_write;
    let cleaned = ref false in
    Fun.protect ~finally:(fun () ->
      Unix.close ready_read;
      if not !cleaned then (
        (try Unix.kill child Sys.sigkill with Unix.Unix_error _ -> ());
        ignore (Unix.waitpid [] child))) (fun () ->
      let byte = Bytes.create 1 in
      Alcotest.(check int) "switch owns migration lock" 1 (Unix.read ready_read byte 0 1);
      refusal root "migration-busy";
      no_target root;
      Unix.kill child Sys.sigkill;
      ignore (Unix.waitpid [] child);
      cleaned := true;
      (* Kernel releases the POSIX lock on crash; durable evidence must still
         block a later migrator, without modifying or replaying the switch. *)
      refusal root "migration-busy";
      no_target root;
      Alcotest.(check string) "switch evidence preserved" "private switch receipt"
        (read (legacy_switch_marker root));
      Unix.unlink (legacy_switch_marker root);
      success root 0 0))

let legacy_switch_foreign_entry_fails_closed () =
  List.iter (fun kind -> fixture (fun root ->
    write (source root) (legacy []);
    let path = legacy_switch_marker root in
    (match kind with
     | `File -> write path "malformed"
     | `Directory -> Unix.mkdir path 0o700
     | `Symlink -> Unix.symlink "missing" path);
    refusal root "migration-busy";
    no_target root)) [`File; `Directory; `Symlink]

let unsafe_migration_lock () =
  List.iter
    (fun poison ->
      fixture (fun root ->
          let original = legacy [] in
          write (source root) original;
          let path = migration_lock root in
          let foreign = Filename.concat root "foreign" in
          (match poison with
          | `Symlink -> Unix.symlink (source root) path
          | `Hardlink ->
              write foreign "foreign private file";
              Unix.link foreign path
          | `Mode ->
              write path "foreign mode";
              Unix.chmod path 0o644);
          refusal root "migration-unsafe-configuration-root";
          no_target root;
          Alcotest.(check string) "legacy unchanged" original
            (read (source root))))
    [ `Symlink; `Hardlink; `Mode ]

let already_retired () =
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      write (marker root) "foreign retirement marker";
      refusal root "migration-already-retired";
      Alcotest.(check bool)
        "retired registry is not recreated" false
        (Sys.file_exists (target root));
      Alcotest.(check string)
        "foreign marker not overwritten" "foreign retirement marker"
        (read (marker root));
      Unix.chmod (marker root) 0o666;
      refusal root "migration-already-retired";
      Unix.chmod (marker root) 0o600;
      let other = Filename.concat root "other" in
      Unix.rename (marker root) other;
      Unix.symlink other (marker root);
      refusal root "migration-already-retired";
      Unix.unlink (marker root);
      Unix.symlink (Filename.concat root "absent") (marker root);
      refusal root "migration-already-retired";
      Unix.unlink (marker root);
      Unix.link other (marker root);
      refusal root "migration-already-retired";
      Unix.unlink (marker root);
      Unix.mkdir (marker root) 0o700;
      refusal root "migration-already-retired";
      write (target root) "existing registry wins refusal precedence";
      refusal root "migration-target-exists";
      Alcotest.(check string)
        "retired source unchanged" original
        (read (source root)))

let marker_failures () =
  List.iter
    (fun failure ->
      fixture (fun root ->
          let original = legacy [] in
          write (source root) original;
          let content = "{\"version\":1,\"profiles\":[]}\n" in
          let directory =
            Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0
          in
          let closed = ref false and calls = ref 0 in
          Fun.protect
            ~finally:(fun () -> if not !closed then Unix.close directory)
            (fun () ->
              let result =
                M.publish ~root ~directory
                  ~before_publish:(fun () ->
                    incr calls;
                    if !calls = 1 then Ok ()
                    else (
                      Alcotest.(check string)
                        "complete registry precedes marker publication" content
                        (read (target root));
                      match failure with
                      | `Refuse -> Error M.Unsafe_source
                      | `Race ->
                          write (marker root) "concurrent retirement";
                          Ok ()
                      | `Sync ->
                          Unix.close directory;
                          closed := true;
                          Ok ()))
                  content
              in
              Alcotest.(check int)
                "marker publication attempted after registry" 2 !calls;
              Alcotest.(check bool)
                "marker failure reports uncertainty" true
                (result = Error M.Publication_uncertain);
              Alcotest.(check string)
                "complete registry retained on marker failure" content
                (read (target root));
              Alcotest.(check string)
                "legacy source untouched on marker failure" original
                (read (source root));
              (match failure with
              | `Refuse ->
                  Alcotest.(check bool)
                    "failed marker not published" false
                    (Sys.file_exists (marker root))
              | `Race ->
                  Alcotest.(check string)
                    "racing marker not overwritten" "concurrent retirement"
                    (read (marker root))
              | `Sync ->
                  Alcotest.(check bool)
                    "complete private marker retained after fsync failure" true
                    (M.private_file (Unix.lstat (marker root))));
              refusal root "migration-target-exists";
              Alcotest.(check bool)
                "no failed marker staging debris" false
                (Array.exists
                   (String.starts_with ~prefix:".backend-profiles-")
                   (Sys.readdir root)))))
    [ `Refuse; `Race; `Sync ]

let recorded_marker_failure () =
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content, _, _ =
        match M.convert original with
        | Ok result -> result
        | Error _ -> Alcotest.fail "fixture conversion"
      in
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      let calls = ref 0 in
      let result =
        Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
            M.publish ~origin:(Unix.lstat (source root), original) ~root
              ~directory ~before_publish:(fun () ->
                incr calls;
                if !calls = 1 then Ok () else Error M.Unsafe_source)
              content)
      in
      Alcotest.(check bool) "marker refusal is uncertain" true
        (result = Error M.Publication_uncertain);
      Alcotest.(check int) "only one target link after interruption" 1
        (Unix.lstat (target root)).Unix.st_nlink;
      Alcotest.(check bool) "record retained before marker" true
        (Sys.file_exists (intent root));
      success root 0 0;
      Alcotest.(check bool) "successful retry retires intent" false
        (Sys.file_exists (intent root)))

let host_only () =
  fixture (fun root ->
      write (source root) (legacy []);
      List.iter
        (fun args ->
          let status, response = run root args in
          Alcotest.(check bool)
            "not an HTTP operation" true (status = Unix.WEXITED 1);
          Alcotest.(check bool)
            "unsupported arguments" true
            (Yojson.Safe.Util.member "code" response = s "unsupported-arguments");
          no_target root)
        [
          [ "--http"; "migrate" ];
          [ "--http"; "profiles.migrate" ];
          [ "migrate"; "--force" ];
        ])

let publication_boundaries () =
  fixture (fun root ->
      let original = legacy [] in
      write (source root) original;
      let content = "{\"version\":1,\"profiles\":[]}\n" in
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect
        ~finally:(fun () -> Unix.close directory)
        (fun () ->
          let reached = ref false in
          let result =
            M.publish ~root ~directory
              ~before_publish:(fun () ->
                reached := true;
                let staged =
                  Array.to_list (Sys.readdir root)
                  |> List.filter
                       (String.starts_with ~prefix:".backend-profiles-")
                in
                Alcotest.(check int)
                  "one complete stage before publication" 1 (List.length staged);
                List.iter
                  (fun name ->
                    let path = Filename.concat root name in
                    Alcotest.(check string)
                      "staged bytes complete" content (read path);
                    Alcotest.(check int)
                      "stage private" 0o600
                      ((Unix.stat path).Unix.st_perm land 0o777))
                  staged;
                Error M.Unsafe_source)
              content
          in
          Alcotest.(check bool)
            "revalidation after staging reached" true !reached;
          Alcotest.(check bool)
            "typed prepublication refusal" true
            (result = Error M.Unsafe_source);
          no_target root;
          Alcotest.(check string)
            "source byte unchanged after rollback" original
            (read (source root));
          let result =
            M.publish ~root ~directory
              ~before_publish:(fun () ->
                write (target root) "concurrent foreign target";
                Ok ())
              content
          in
          Alcotest.(check bool)
            "racing target no-clobber" true
            (result = Error M.Target_exists);
          Alcotest.(check string)
            "racing target not overwritten" "concurrent foreign target"
            (read (target root));
          Alcotest.(check int)
            "rollback cleans stage" 2
            (Array.length (Sys.readdir root))))

let publication_is_readable_before_ack () =
  fixture (fun root ->
      let content = "{\"version\":1,\"profiles\":[]}\n" in
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
        let observed = ref false in
        let result = M.publish_file ~root ~directory ~destination:(target root)
          ~exists:M.Target_exists ~before_publish:(fun () -> Ok ())
          ~after_publish:(fun () ->
            observed := true;
            Alcotest.(check int) "single link when registry becomes visible" 1
              (Unix.lstat (target root)).Unix.st_nlink;
            Alcotest.(check bool) "actual loader can read before acknowledgement" true
              (Result.is_ok (P.load ~root));
            raise (Unix.Unix_error (Unix.EIO, "interrupted", ""))) content in
        Alcotest.(check bool) "post-publication boundary reached" true !observed;
        Alcotest.(check bool) "interruption reported uncertain" true
          (result = Error M.Publication_uncertain);
        Alcotest.(check bool) "published registry remains readable" true
          (Result.is_ok (P.load ~root))))

let uncertain_publication () =
  fixture (fun root ->
      write (source root) (legacy []);
      let content = "{\"version\":1,\"profiles\":[]}\n" in
      (* fsync on a read-only regular file succeeds; a closed descriptor gives a
     deterministic post-link failure without touching any external filesystem. *)
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      let result =
        M.publish ~root ~directory
          ~before_publish:(fun () ->
            Unix.close directory;
            Ok ())
          content
      in
      Alcotest.(check bool)
        "post-link failure reports uncertainty" true
        (result = Error M.Publication_uncertain);
      Alcotest.(check string)
        "complete target retained, not rolled back" content
        (read (target root));
      Alcotest.(check int)
        "single link despite uncertainty" 1
        (Unix.stat (target root)).Unix.st_nlink;
      refusal root "migration-target-exists";
      Alcotest.(check int)
         "no staging debris, only persistent lock" 3
         (Array.length (Sys.readdir root)))

let custody_predicate () =
  fixture (fun root ->
      write (source root) (legacy []);
      let st = Unix.lstat (source root) in
      Alcotest.(check bool) "native private file" true (M.private_file st);
      List.iter
        (fun st ->
          Alcotest.(check bool)
            "foreign or aliased file refused" false (M.private_file st))
        [
          { st with Unix.st_uid = st.Unix.st_uid + 1 };
          { st with Unix.st_nlink = 2 };
          { st with Unix.st_kind = Unix.S_LNK };
          { st with Unix.st_perm = 0o620 };
        ])

let missing_or_aliased_mesh_root () =
  fixture (fun root ->
      let missing = Filename.concat root "missing" in
      refusal missing "migration-unsafe-configuration-root";
      Alcotest.(check bool)
        "Mesh root never created" false (Sys.file_exists missing);
      let alias = Filename.concat root "alias" in
      Unix.symlink root alias;
      refusal alias "migration-unsafe-configuration-root";
       no_target root)

let first_create_interruption () =
  let prelink_fixture f =
    fixture (fun root ->
        let stage =
          Filename.concat root ".backend-profiles-123-0123456789abcdef.tmp"
        and content = "{\"version\":1,\"profiles\":[]}\n" in
        let original = legacy [] in
        write (source root) original;
        write stage content;
        let directory =
          Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0
        in
        Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
            M.write_first_intent ~root ~directory ~stage ~content);
        f root stage content original)
  in
  fixture (fun root ->
      let config = Filename.concat root "config" and history = Filename.concat root "history" in
      Unix.mkdir config 0o700; Unix.mkdir history 0o700;
      let marker = Filename.concat root ".backend-profiles.legacy-switch" in
      write marker "retained switch evidence";
      let profile = `Assoc [ ("id", s "work"); ("label", s "Work");
        ("backend", s "claude"); ("roots", `Assoc [("config", s config); ("history", s history)]) ] in
      Alcotest.(check bool) "legacy switch blocks initial profile create" true
        (M.create_profile ~root ~expected_revision:None ~profile = Error "profile-migration-required");
      Alcotest.(check bool) "no registry created" false (Sys.file_exists (target root));
      Alcotest.(check string) "legacy switch evidence retained" "retained switch evidence" (read marker));
  fixture (fun root ->
      let config = Filename.concat root "config" and history = Filename.concat root "history" in
      Unix.mkdir config 0o700; Unix.mkdir history 0o700;
      let profile = `Assoc [ ("id", s "work"); ("label", s "Work");
        ("backend", s "claude"); ("roots", `Assoc [("config", s config); ("history", s history)]) ] in
      let revision = match M.create_profile ~root ~expected_revision:None ~profile with
        | Ok (revision, _) -> revision | Error err -> Alcotest.fail err in
      let original = read (target root) in
      let marker = Filename.concat root ".backend-profiles.legacy-switch" in
      Unix.symlink "missing" marker;
      Alcotest.(check bool) "dangling marker blocks append" true
        (M.create_profile ~root ~expected_revision:(Some revision) ~profile = Error "profile-migration-required");
      Alcotest.(check string) "registry retained" original (read (target root));
      Alcotest.(check bool) "marker retained" true ((Unix.lstat marker).Unix.st_kind = Unix.S_LNK));
  prelink_fixture (fun root stage content original ->
      let marker = Filename.concat root ".backend-profiles.legacy-switch" in
      write marker "retained switch evidence";
      let status, _ = run root [ "recover-create" ] in
      Alcotest.(check bool) "legacy switch blocks recovery" true (status = Unix.WEXITED 1);
      Alcotest.(check string) "stage retained" content (read stage);
      Alcotest.(check string) "source retained" original (read (source root));
      Alcotest.(check string) "switch evidence retained" "retained switch evidence" (read marker);
      Alcotest.(check bool) "create intent retained" true
        (Sys.file_exists (Filename.concat root ".backend-profiles.create-intent")));
  prelink_fixture (fun root stage _ original ->
      refusal root "migration-target-exists";
      Alcotest.(check bool) "create cannot replay pending first intent" true
        (M.create_profile ~root ~expected_revision:None ~profile:`Null
        = Error "profile-publication-uncertain");
      let status, response = run root [ "recover-create" ] in
      Alcotest.(check bool) "explicit prelink abort" true
        (status = Unix.WEXITED 0);
      Alcotest.(check string) "path-free prelink reply"
        {|{"version":1,"ok":true,"data":{"outcome":"unpublished-aborted"}}|}
        (Yojson.Safe.to_string response);
      Alcotest.(check bool) "unpublished target stays absent" false
        (Sys.file_exists (target root));
      Alcotest.(check bool) "verified stage retired" false
        (Sys.file_exists stage);
      Alcotest.(check bool) "verified intent retired" false
        (Sys.file_exists (Filename.concat root ".backend-profiles.create-intent"));
      Alcotest.(check string) "legacy bytes retained" original
        (read (source root));
      let config = Filename.concat root "config"
      and history = Filename.concat root "history" in
      Unix.mkdir config 0o700;
      Unix.mkdir history 0o700;
      let requested =
        `Assoc
          [
            ("id", s "explicit-new-request");
            ("label", s "Explicit");
            ("backend", s "claude");
            ( "roots",
              `Assoc [ ("config", s config); ("history", s history) ] );
          ]
      in
      Alcotest.(check bool) "only an explicit new request can publish" true
        (Result.is_ok
           (M.create_profile ~root ~expected_revision:None ~profile:requested));
      Alcotest.(check bool) "new request published" true
        (Sys.file_exists (target root)));
  prelink_fixture (fun root stage content original ->
      let intent = Filename.concat root ".backend-profiles.create-intent" in
      Unix.unlink intent;
      write intent "not an intent";
      let status, _ = run root [ "recover-create" ] in
      Alcotest.(check bool) "malformed intent refuses" true
        (status = Unix.WEXITED 1);
      Alcotest.(check string) "malformed intent stays" "not an intent" (read intent);
      Alcotest.(check string) "stage unchanged" content (read stage);
      Alcotest.(check string) "source unchanged" original (read (source root)));
  prelink_fixture (fun root stage content _ ->
      let replacement = Filename.concat root "replacement" in
      write replacement content;
      Unix.rename replacement stage;
      let status, _ = run root [ "recover-create" ] in
      Alcotest.(check bool) "same bytes without recorded inode refuse" true
        (status = Unix.WEXITED 1);
      Alcotest.(check string) "replacement stage remains" content (read stage);
      Alcotest.(check bool) "intent remains" true
        (Sys.file_exists (Filename.concat root ".backend-profiles.create-intent")));
  prelink_fixture (fun root stage content _ ->
      let foreign = Filename.concat root "foreign" in
      write foreign content;
      Unix.rename foreign (target root);
      let status, _ = run root [ "recover-create" ] in
      Alcotest.(check bool) "prelink abort never removes foreign target" true
        (status = Unix.WEXITED 1);
      Alcotest.(check string) "foreign target intact" content
        (read (target root));
      Alcotest.(check string) "recorded stage intact" content (read stage));
  prelink_fixture (fun root stage _ _ ->
      let fd = Unix.openfile stage [ Unix.O_WRONLY; Unix.O_TRUNC ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
          ignore (Unix.write_substring fd "changed" 0 7));
      let status, _ = run root [ "recover-create" ] in
      Alcotest.(check bool) "changed bytes refuse prelink abort" true
        (status = Unix.WEXITED 1);
      Alcotest.(check string) "changed stage retained" "changed" (read stage));
  prelink_fixture (fun root stage _ _ ->
      Unix.unlink stage;
      let status, _ = run root [ "recover-create" ] in
      Alcotest.(check bool) "both names absent refuse" true
        (status = Unix.WEXITED 1);
      Alcotest.(check bool) "intent held for manual reconciliation" true
        (Sys.file_exists (Filename.concat root ".backend-profiles.create-intent")));
  prelink_fixture (fun root stage content _ ->
      Unix.unlink (Filename.concat root ".backend-profiles.create-intent");
      let status, _ = run root [ "recover-create" ] in
      Alcotest.(check bool) "stage alone lacks provenance" true
        (status = Unix.WEXITED 1);
      Alcotest.(check string) "unwitnessed stage remains" content (read stage));
  prelink_fixture (fun root stage content original ->
      (* Model interruption immediately after the unpublished recovery retires
         and syncs its checked intent, before optional stage cleanup. This is
         not a process-kill test of the exact instruction boundary. *)
      let identity = Unix.lstat stage in
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
          Unix.unlink (Filename.concat root ".backend-profiles.create-intent");
          Unix.fsync directory);
      Alcotest.(check bool) "no pending intent without evidence" false
        (Sys.file_exists (Filename.concat root ".backend-profiles.create-intent"));
      Alcotest.(check bool) "no publication from abort" false
        (Sys.file_exists (target root));
      Alcotest.(check int) "private orphan still singly linked" 1
        (Unix.lstat stage).Unix.st_nlink;
      Alcotest.(check string) "orphan content unchanged" content (read stage);
      Alcotest.(check string) "source unchanged" original (read (source root));
      let status, _ = run root [ "recover-create" ] in
      Alcotest.(check bool) "no inference from orphan alone" true
        (status = Unix.WEXITED 1);
      Alcotest.(check bool) "new request is not held by stranded intent" true
        (M.create_profile ~root ~expected_revision:None ~profile:`Null
        = Error "invalid-request");
      M.cleanup_first_stage ~root ~stage ~identity;
      Alcotest.(check bool) "optional exact cleanup" false
        (Sys.file_exists stage));
  prelink_fixture (fun root stage content _ ->
      let identity = Unix.lstat stage in
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
          Unix.unlink (Filename.concat root ".backend-profiles.create-intent");
          Unix.fsync directory);
      let replacement = Filename.concat root "replacement" in
      write replacement content;
      Unix.rename replacement stage;
      M.cleanup_first_stage ~root ~stage ~identity;
      Alcotest.(check string) "replacement orphan not removed" content
        (read stage));
  prelink_fixture (fun root stage content _ ->
      M.cleanup_first_stage ~root ~stage ~identity:(Unix.lstat stage);
      Alcotest.(check string) "failed create keeps evidenced stage" content
        (read stage);
      Alcotest.(check bool) "pending intent still blocks retry" true
        (M.create_profile ~root ~expected_revision:None ~profile:`Null
        = Error "profile-publication-uncertain"));
  fixture (fun root ->
      let stage =
        Filename.concat root ".backend-profiles-123-0123456789abcdef.tmp"
      in
      write stage "unpublished";
      M.cleanup_first_stage ~root ~stage ~identity:(Unix.lstat stage);
      Alcotest.(check bool) "unwitnessed temporary stage cleaned" false
        (Sys.file_exists stage));
  fixture (fun root ->
      let stage = Filename.concat root ".backend-profiles-123-0123456789abcdef.tmp" in
      let config = Filename.concat root "config"
      and history = Filename.concat root "history" in
      Unix.mkdir config 0o700;
      Unix.mkdir history 0o700;
      let content =
        Yojson.Safe.to_string
          (`Assoc
             [
               ("version", `Int 1);
               ( "profiles",
                 `List
                   [
                     `Assoc
                       [
                         ("id", s "known");
                         ("label", s "Known");
                         ("backend", s "claude");
                         ("enabled", `Bool true);
                         ( "roots",
                           `Assoc
                             [ ("config", s config); ("history", s history) ] );
                       ];
                   ] );
             ])
        ^ "\n"
      in
      let original = legacy [] in
      write (source root) original;
      write stage content;
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
          M.write_first_intent ~root ~directory ~stage ~content;
          Unix.link stage (target root);
          refusal root "migration-target-exists";
          Alcotest.(check bool) "create cannot replay pending publication" true
            (M.create_profile ~root ~expected_revision:None ~profile:`Null
            = Error "profile-publication-uncertain");
          Alcotest.(check bool) "ordinary loader refuses two links" true
            (Result.is_error (P.load ~root));
          let status, response = run root [ "recover-create" ] in
           Alcotest.(check bool) "explicit host recovery" true
             (status = Unix.WEXITED 0);
           Alcotest.(check string) "path-free recovery reply"
             {|{"version":1,"ok":true,"data":{"outcome":"published-reconciled"}}|}
            (Yojson.Safe.to_string response);
          Alcotest.(check string) "exact first registry preserved" content
            (read (target root));
          Alcotest.(check string) "legacy bytes preserved" original
            (read (source root));
          Alcotest.(check int) "single link restored" 1
            (Unix.lstat (target root)).Unix.st_nlink;
          Alcotest.(check bool) "known profile retained" true
            (match P.load ~root with
            | Ok (Some registry) ->
                List.exists (fun p -> P.id p = "known") (P.profiles registry)
            | _ -> false);
          Alcotest.(check bool) "only recorded stage removed" false
            (Sys.file_exists stage)));
  fixture (fun root ->
      let stage = Filename.concat root ".backend-profiles-123-0123456789abcdef.tmp" in
      let content = "{\"version\":1,\"profiles\":[]}\n" in
      write stage content;
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
          M.write_first_intent ~root ~directory ~stage ~content;
          Unix.link stage (target root);
          Unix.unlink stage;
          let status, _ = run root [ "recover-create" ] in
          Alcotest.(check bool) "post-unlink intent retired explicitly" true
            (status = Unix.WEXITED 0);
          Alcotest.(check bool) "intent removed after verified target" false
            (Sys.file_exists (Filename.concat root ".backend-profiles.create-intent"));
          Alcotest.(check bool) "ordinary loader reads recovered registry" true
            (Result.is_ok (P.load ~root))));
  fixture (fun root ->
      let stage = Filename.concat root ".backend-profiles-123-0123456789abcdef.tmp" in
      let content = "{\"version\":1,\"profiles\":[]}\n" in
      write stage content;
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
          M.write_first_intent ~root ~directory ~stage ~content;
          Unix.link stage (target root);
          let replacement = Filename.concat root "replacement" in
          write replacement content;
          Unix.rename replacement (target root);
          let status, _ = run root [ "recover-create" ] in
          Alcotest.(check bool) "unverified replacement refused" true
            (status = Unix.WEXITED 1);
          Alcotest.(check bool) "intent retained" true
            (Sys.file_exists (Filename.concat root ".backend-profiles.create-intent"));
          Alcotest.(check bool) "stage retained" true
            (Sys.file_exists stage);
          Alcotest.(check string) "replacement untouched" content
            (read (target root))));
  fixture (fun root ->
      let stage = Filename.concat root ".backend-profiles-123-0123456789abcdef.tmp" in
      let content = "{\"version\":1,\"profiles\":[]}\n" in
      write stage content;
      Unix.link stage (target root);
      let status, _ = run root [ "recover-create" ] in
      Alcotest.(check bool) "matching bytes and name are not provenance" true
        (status = Unix.WEXITED 1);
      Alcotest.(check int) "unwitnessed link preserved" 2
        (Unix.lstat (target root)).Unix.st_nlink);
  fixture (fun root ->
      let stage = Filename.concat root ".backend-profiles-123-0123456789abcdef.tmp" in
      let content = "{\"version\":1,\"profiles\":[]}\n" in
      write stage content;
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
          M.write_first_intent ~root ~directory ~stage ~content;
          Unix.link stage (target root);
          write (source root) (legacy [ account ~claude:"/private/fixture" "existing" ]);
          let status, _ = run root [ "recover-create" ] in
          Alcotest.(check bool) "legacy change refuses recovery" true
            (status = Unix.WEXITED 1);
          Alcotest.(check int) "no link removed" 2
            (Unix.lstat (target root)).Unix.st_nlink));
  fixture (fun root ->
      let stage = Filename.concat root ".backend-profiles-123-0123456789abcdef.tmp" in
      let content = "{\"version\":1,\"profiles\":[]}\n" in
      write stage content;
      let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
          M.write_first_intent ~root ~directory ~stage ~content;
          let config = Filename.concat root "credential-root" in
          Unix.mkdir config 0o700;
          write (source root) (legacy [ account ~claude:config "existing" ]);
          refusal root "migration-target-exists";
          Alcotest.(check bool) "prelink create intent still held" true
            (Sys.file_exists (Filename.concat root ".backend-profiles.create-intent"));
          Alcotest.(check bool) "migration made no target" false
            (Sys.file_exists (target root))))

let provision_interruption ~replace_stage ~append ~point () =
  fixture (fun root ->
      let profile label = `Assoc [ ("backend", s "codex"); ("label", s label) ] in
      let before =
        if not append then None
        else
          match M.provision_profile ~root ~expected_revision:None ~profile:(profile "Existing") with
          | Error code -> Alcotest.fail code
          | Ok (revision, _) ->
              Alcotest.(check bool) "confirmed provision reconciled" true
                (recover_provision root = Ok M.Published_reconciled);
              Some (revision, read (target root), Unix.lstat (target root))
      in
      let revision = Option.map (fun (revision, _, _) -> revision) before in
      let requested = profile "Interrupted" in
      let roots () =
        Sys.readdir root |> Array.to_list
        |> List.filter (String.starts_with ~prefix:"profile-p-")
        |> List.sort String.compare
        |> List.map (Filename.concat root)
      in
      let old_roots = roots () in
      let snapshot path =
        let st = Unix.lstat path in
        (st.Unix.st_dev, st.Unix.st_ino, read path)
      in
      let sentinel base =
        Filename.concat (Filename.concat base "config") "sessions/witness"
      in
      List.iter (fun base -> write (sentinel base) "existing") old_roots;
      (match Unix.fork () with
      | 0 ->
          let checkpoint actual =
            if actual = point then (
              Unix.kill (Unix.getpid ()) Sys.sigkill;
              Unix._exit 126)
          in
          ignore (M.write_profile ~checkpoint ~provision:true ~root
                    ~expected_revision:revision ~profile:requested ());
          Unix._exit 125
      | pid ->
          Alcotest.(check bool) "writer killed at the requested boundary" true
            (snd (Unix.waitpid [] pid) = Unix.WSIGNALED Sys.sigkill));
      let allocated = roots () in
      let new_root =
        match List.filter (fun path -> not (List.mem path old_roots)) allocated with
        | [path] -> path
        | _ -> Alcotest.fail "exactly one new native root"
      in
      write (sentinel new_root) "retained";
      let witnesses = List.map (fun root -> snapshot (sentinel root)) allocated in
      let published = point = M.After_publish in
      let provision_stage =
        let intent = Filename.concat root ".backend-profiles.provision-intent" in
        Filename.concat root Yojson.Safe.Util.(Yojson.Safe.from_string (read intent) |> member "stage" |> to_string) in
      let destination = target root in
      let recorded = if Sys.file_exists destination then Some (snapshot destination) else None in
      (match before with
      | None ->
          Alcotest.(check bool) "target only exists after link" published (Option.is_some recorded);
          Alcotest.(check bool) "intent blocks a second write" true
            (M.provision_profile ~root ~expected_revision:None ~profile:requested
             = Error "profile-publication-uncertain")
      | Some (_, bytes, st) when not published ->
          Alcotest.(check bool) "append before rename preserves old inode and bytes" true
            (recorded = Some (st.Unix.st_dev, st.Unix.st_ino, bytes));
          Alcotest.(check bool) "interrupted allocation blocks a second provision" true
            (M.provision_profile ~root ~expected_revision:revision ~profile:requested
             = Error "profile-publication-uncertain")
      | Some _ ->
          Alcotest.(check bool) "stale append cannot replay" true
            (M.provision_profile ~root ~expected_revision:revision ~profile:requested
             = Error "profile-publication-uncertain"));
      if not append then (
        let evidence = Filename.concat root ".backend-profiles.create-intent" in
        let stage = Filename.concat root
          Yojson.Safe.Util.(Yojson.Safe.from_string (read evidence) |> member "stage" |> to_string) in
        let legacy_switch = Filename.concat root ".backend-profiles.legacy-switch" in
        write legacy_switch "contradictory synthetic evidence";
        let held = List.map snapshot [evidence; stage; legacy_switch] in
        let status, _ = run root ["recover-create"] in
        Alcotest.(check bool) "legacy evidence prevents explicit recovery" true
          (status = Unix.WEXITED 1);
        Alcotest.(check bool) "intent, stage, and marker retain their inodes and bytes" true
          (List.map snapshot [evidence; stage; legacy_switch] = held);
        Alcotest.(check bool) "contradiction does not replace the target" true
          (recorded = (if Sys.file_exists destination then Some (snapshot destination) else None));
        Unix.unlink legacy_switch);
      if append && not published then (
        let old = Filename.concat root "original-registry" in
        Unix.rename destination old;
        write destination (read old);
        Alcotest.(check bool) "same bytes from another inode cannot resolve" true
          (recover_provision root = Error "profile-publication-uncertain");
        Unix.unlink destination;
        Unix.rename old destination;
        if replace_stage then (Unix.unlink provision_stage; write provision_stage "foreign-stage"));
      let status, response = run root ["recover-create"] in
      if append then
        Alcotest.(check bool) "first-create recovery does not interpret an append" true
          (status = Unix.WEXITED 1)
      else (
        Alcotest.(check bool) "explicit first-create recovery" true (status = Unix.WEXITED 0);
        let outcome = Yojson.Safe.Util.(response |> member "data" |> member "outcome" |> to_string) in
        Alcotest.(check string) "recovery never publishes a stage"
          (if published then "published-reconciled" else "unpublished-aborted") outcome);
      Alcotest.(check bool) "explicit provision reconciliation" true
        (recover_provision root = Ok (if published then M.Published_reconciled else M.Unpublished_aborted));
      if append && not published then
        if replace_stage then
          Alcotest.(check string) "foreign stage preserved" "foreign-stage" (read provision_stage)
        else Alcotest.(check bool) "verified unpublished stage removed" false (Sys.file_exists provision_stage);
      Alcotest.(check bool) "recovery never replaces the registry" true
        (recorded = (if Sys.file_exists destination then Some (snapshot destination) else None));
      let count = Bool.to_int append + Bool.to_int published in
      let loaded = match P.load ~root with
        | Ok registry -> Option.fold ~none:[] ~some:P.profiles registry
        | Error _ -> Alcotest.fail "explicit read cannot determine surviving registry"
      in
      Alcotest.(check int) "only published rows visible" count (List.length loaded);
      Alcotest.(check bool) "every surviving row stays disabled" true
        (List.for_all (fun p -> not (P.enabled p)) loaded);
      Alcotest.(check bool) "directory witnesses retain inodes and bytes" true
        (roots () = allocated && List.map (fun root -> snapshot (sentinel root)) allocated = witnesses))

let provision_old_acknowledgement_cannot_resolve_new_intent () =
  fixture (fun root ->
    let profile label = `Assoc [("backend", s "codex"); ("label", s label)] in
    let revision = match M.provision_profile ~root ~expected_revision:None ~profile:(profile "First") with
      | Ok (revision, _) -> revision | Error code -> Alcotest.fail code in
    let first = match M.inspect_provision ~root with Ok proof -> proof | Error code -> Alcotest.fail code in
    Alcotest.(check bool) "first proof resolves first" true
      (M.recover_provision ~root ~expected:first = Ok M.Published_reconciled);
    Alcotest.(check bool) "second provision succeeds" true
      (Result.is_ok (M.provision_profile ~root ~expected_revision:(Some revision) ~profile:(profile "Second")));
    let second = match M.inspect_provision ~root with Ok proof -> proof | Error code -> Alcotest.fail code in
    Alcotest.(check bool) "delayed first proof cannot clear second" true
      (M.recover_provision ~root ~expected:first = Ok M.Published_reconciled);
    Alcotest.(check bool) "second proof remains valid" true
      (M.recover_provision ~root ~expected:second = Ok M.Published_reconciled);
    Alcotest.(check bool) "first result survives a later completed operation" true
      (M.recover_provision ~root ~expected:first = Ok M.Published_reconciled))

let provision_combined_first_recovery point () =
  fixture (fun root ->
    let profile = `Assoc [("backend", s "codex"); ("label", s "Interrupted first")] in
    (match Unix.fork () with
    | 0 -> let checkpoint actual = if actual = point then Unix.kill (Unix.getpid ()) Sys.sigkill in
      ignore (M.write_profile ~checkpoint ~provision:true ~root ~expected_revision:None ~profile ()); Unix._exit 125
    | pid -> Alcotest.(check bool) "writer interrupted" true (snd (Unix.waitpid [] pid) = Unix.WSIGNALED Sys.sigkill));
    let roots = Sys.readdir root |> Array.to_list |> List.filter (String.starts_with ~prefix:"profile-p-") in
    let proof, outcome = match M.inspect_provision_outcome ~root with Ok result -> result | Error e -> Alcotest.fail e in
    Alcotest.(check bool) "inspection leaves both intents" true
      (Sys.file_exists (Filename.concat root ".backend-profiles.create-intent")
       && Sys.file_exists (Filename.concat root ".backend-profiles.provision-intent"));
    let expected = if point = M.After_publish then M.Published_reconciled else M.Unpublished_aborted in
    Alcotest.(check bool) "correct outcome" true (outcome = expected);
    Alcotest.(check bool) "stale confirmation refused" true
      (M.recover_provision ~root ~expected:(proof ^ "x") = Error "profile-publication-uncertain");
    Alcotest.(check bool) "both records reconciled" true (M.recover_provision ~root ~expected:proof = Ok expected);
    Alcotest.(check bool) "allocated roots retained" true
      (roots = (Sys.readdir root |> Array.to_list |> List.filter (String.starts_with ~prefix:"profile-p-")));
    Alcotest.(check bool) "retry succeeds" true (M.recover_provision ~root ~expected:proof = Ok expected))

let provision_old_ack_refuses_new_first_intent () =
  fixture (fun root ->
    let profile = `Assoc [("backend", s "codex"); ("label", s "Interrupted")] in
    let interrupt () = match Unix.fork () with
      | 0 -> let checkpoint = function M.Before_publish -> Unix.kill (Unix.getpid ()) Sys.sigkill | _ -> () in
        ignore (M.write_profile ~checkpoint ~provision:true ~root ~expected_revision:None ~profile ()); Unix._exit 125
      | pid -> Alcotest.(check bool) "publisher killed" true (snd (Unix.waitpid [] pid) = Unix.WSIGNALED Sys.sigkill) in
    interrupt ();
    let first, _ = match M.inspect_provision_outcome ~root with Ok v -> v | Error e -> Alcotest.fail e in
    Alcotest.(check bool) "first reconciled" true (M.recover_provision ~root ~expected:first = Ok M.Unpublished_aborted);
    interrupt ();
    let second, _ = match M.inspect_provision_outcome ~root with Ok v -> v | Error e -> Alcotest.fail e in
    let first_intent = Filename.concat root ".backend-profiles.create-intent" in
    let before = (read first_intent, (Unix.lstat first_intent).Unix.st_ino) in
    Alcotest.(check bool) "stale confirmation refused" true
      (M.recover_provision ~root ~expected:first = Ok M.Unpublished_aborted);
    Alcotest.(check bool) "new first intent untouched" true
      ((read first_intent, (Unix.lstat first_intent).Unix.st_ino) = before);
    Alcotest.(check bool) "second still reconciles" true
      (M.recover_provision ~root ~expected:second = Ok M.Unpublished_aborted))

let provision_first_recovery_interruption point () =
  fixture (fun root ->
    let profile = `Assoc [("backend", s "codex"); ("label", s "Recovery interruption")] in
    (match Unix.fork () with
    | 0 -> let checkpoint actual = if actual = point then Unix.kill (Unix.getpid ()) Sys.sigkill in
      ignore (M.write_profile ~checkpoint ~provision:true ~root ~expected_revision:None ~profile ()); Unix._exit 125
    | pid -> Alcotest.(check bool) "publisher killed" true (snd (Unix.waitpid [] pid) = Unix.WSIGNALED Sys.sigkill));
    let proof, outcome = match M.inspect_provision_outcome ~root with Ok v -> v | Error e -> Alcotest.fail e in
    (match Unix.fork () with
    | 0 -> let checkpoint actual = if actual = `First_reconciled then Unix.kill (Unix.getpid ()) Sys.sigkill in
      ignore (M.recover_provision_with_checkpoint ~checkpoint ~root ~expected:proof ()); Unix._exit 125
    | pid -> Alcotest.(check bool) "reconciler killed" true (snd (Unix.waitpid [] pid) = Unix.WSIGNALED Sys.sigkill));
    Alcotest.(check bool) "same confirmation resumes" true (M.recover_provision ~root ~expected:proof = Ok outcome))

let provision_inspection_is_read_only () =
  fixture (fun root ->
    let profile = `Assoc [("backend", s "codex"); ("label", s "Inspect")] in
    Alcotest.(check bool) "provision succeeds" true
      (Result.is_ok (M.provision_profile ~root ~expected_revision:None ~profile));
    let journal = Filename.concat root ".backend-profiles.provision-intent" in
    let before = (read journal, (Unix.lstat journal).Unix.st_ino) in
    let proof, outcome = match M.inspect_provision_outcome ~root with
      | Ok result -> result | Error e -> Alcotest.fail e in
    Alcotest.(check bool) "inspection identifies publication" true (outcome = M.Published_reconciled);
    Alcotest.(check bool) "inspection leaves intent untouched" true ((read journal, (Unix.lstat journal).Unix.st_ino) = before);
    Alcotest.(check bool) "inspection does not unblock subsequent attempts" true
      (M.provision_profile ~root ~expected_revision:None ~profile = Error "profile-publication-uncertain");
    Alcotest.(check bool) "explicit acknowledgement succeeds" true
      (M.recover_provision ~root ~expected:proof = Ok M.Published_reconciled))

let provision_receipt_refuses_changed_operation () =
  fixture (fun root ->
    let profile = `Assoc [("backend", s "codex"); ("label", s "Receipt binding")] in
    let operation = String.make 32 'a' in
    Alcotest.(check bool) "provision succeeds" true
      (Result.is_ok (M.write_profile ~operation_id:operation ~provision:true ~root ~expected_revision:None ~profile ()));
    let proof, _ = match M.inspect_provision_outcome ~root with Ok result -> result | Error e -> Alcotest.fail e in
    Alcotest.(check bool) "acknowledgement succeeds" true (M.recover_provision ~root ~expected:proof = Ok M.Published_reconciled);
    let path = Filename.concat root (".backend-profiles.provision-receipt-" ^ Digestif.SHA256.(to_hex (digest_string proof))) in
    let receipt = Yojson.Safe.from_string (read path) in
    let tampered = match receipt with `Assoc fields -> `Assoc (List.map (fun (k,v) ->
      if k = "operation" then (k, `String (String.make 32 'b')) else (k,v)) fields) | _ -> Alcotest.fail "receipt shape" in
    Out_channel.with_open_bin path (fun channel -> output_string channel (Yojson.Safe.to_string tampered ^ "\n"));
    Alcotest.(check bool) "altered binding cannot be listed" true (Result.is_error (M.list_provision_receipts ~root));
    Alcotest.(check bool) "altered binding cannot confirm retry" true
      (M.recover_provision ~root ~expected:proof = Error "profile-publication-uncertain"))

let provision_receipt_cleanup () =
  fixture (fun root ->
    let profile = `Assoc [("backend", s "codex"); ("label", s "Cleanup")] in
    Alcotest.(check bool) "provision succeeds" true
      (Result.is_ok (M.provision_profile ~root ~expected_revision:None ~profile));
    let proof, _ = match M.inspect_provision_outcome ~root with Ok v -> v | Error e -> Alcotest.fail e in
    (match Unix.fork () with
    | 0 -> let checkpoint p = if p = `Receipt_published then Unix.kill (Unix.getpid ()) Sys.sigkill in
      ignore (M.recover_provision_with_checkpoint ~checkpoint ~root ~expected:proof ()); Unix._exit 125
    | pid -> Alcotest.(check bool) "recovery interrupted" true (snd (Unix.waitpid [] pid) = Unix.WSIGNALED Sys.sigkill));
    Alcotest.(check bool) "active receipt cannot be removed" true
      (M.forget_provision_receipt ~root ~proof = Error "profile-publication-uncertain");
    Alcotest.(check bool) "intent still resolves" true (M.recover_provision ~root ~expected:proof = Ok M.Published_reconciled);
    Alcotest.(check bool) "receipt is listed" true
      (M.list_provision_receipts ~root = Ok [proof, M.Published_reconciled, `Null]);
    Alcotest.(check bool) "explicit removal succeeds" true (M.forget_provision_receipt ~root ~proof = Ok ());
    Alcotest.(check bool) "removal is idempotent" true (M.forget_provision_receipt ~root ~proof = Ok ());
    Alcotest.(check bool) "removed receipt cannot satisfy retry" true
      (M.recover_provision ~root ~expected:proof = Error "profile-publication-uncertain");
    Alcotest.(check bool) "registry remains" true (Sys.file_exists (target root)))

let provision_receipt_interruption point () =
  fixture (fun root ->
    let profile = `Assoc [("backend", s "codex"); ("label", s "Receipt")] in
    Alcotest.(check bool) "provision succeeds" true
      (Result.is_ok (M.provision_profile ~root ~expected_revision:None ~profile));
    let proof = match M.inspect_provision ~root with Ok p -> p | Error e -> Alcotest.fail e in
    let registry = read (target root) in
    (match Unix.fork () with
    | 0 ->
      let checkpoint p = if p = point then Unix.kill (Unix.getpid ()) Sys.sigkill in
      ignore (M.recover_provision_with_checkpoint ~checkpoint ~root ~expected:proof ());
      Unix._exit 125
    | pid -> Alcotest.(check bool) "recovery interrupted" true
        (snd (Unix.waitpid [] pid) = Unix.WSIGNALED Sys.sigkill));
    Alcotest.(check bool) "same proof resolves interrupted recovery" true
      (M.recover_provision ~root ~expected:proof = Ok M.Published_reconciled);
    Alcotest.(check bool) "retry is idempotent" true
      (M.recover_provision ~root ~expected:proof = Ok M.Published_reconciled);
    Alcotest.(check bool) "other proof cannot use receipt" true
      (M.recover_provision ~root ~expected:(proof ^ "x") = Error "profile-publication-uncertain");
    Alcotest.(check string) "registry unchanged" registry (read (target root)))

let provision_recovery_refuses_replaced_root () =
  fixture (fun root ->
    let profile = `Assoc [("backend", s "codex"); ("label", s "Root witness")] in
    Alcotest.(check bool) "provision succeeds" true
      (Result.is_ok (M.provision_profile ~root ~expected_revision:None ~profile));
    let proof = match M.inspect_provision ~root with Ok p -> p | Error e -> Alcotest.fail e in
    let marker_bytes = read (Filename.concat root ".backend-profiles.provision-intent") in
    let registry_bytes = read (target root) in
    let saved = root ^ "-original" in
    Unix.rename root saved;
    Unix.mkdir root 0o700;
    Fun.protect ~finally:(fun () -> cleanup root; Unix.rename saved root) (fun () ->
      write (Filename.concat root ".backend-profiles.provision-intent") marker_bytes;
      write (target root) registry_bytes;
      Alcotest.(check bool) "old proof rejected for replacement root" true
        (M.recover_provision ~root ~expected:proof = Error "profile-publication-uncertain");
      Alcotest.(check bool) "fresh proof cannot adopt replaced root" true
        (recover_provision root = Error "profile-publication-uncertain"));
    Alcotest.(check bool) "original remains reconcilable" true
      (M.recover_provision ~root ~expected:proof = Ok M.Published_reconciled))

let provision_recovery_refuses_changed_registry () =
  fixture (fun root ->
    let profile = `Assoc [("backend", s "codex"); ("label", s "Confirmed")] in
    Alcotest.(check bool) "provision succeeds" true
      (Result.is_ok (M.provision_profile ~root ~expected_revision:None ~profile));
    let evidence = Filename.concat root ".backend-profiles.provision-intent" in
    let proof = read evidence in
    let path = target root in
    let original = read path in
    let backup = Filename.concat root "original-candidate" in
    Unix.rename path backup;
    write path original;
    Alcotest.(check bool) "same-content replacement of published candidate refuses recovery" true
      (recover_provision root = Error "profile-publication-uncertain");
    Unix.unlink path;
    Unix.rename backup path;
    Out_channel.with_open_bin path (fun channel -> output_string channel (original ^ " "));
    Alcotest.(check bool) "changed registry refuses recovery" true
      (recover_provision root = Error "profile-publication-uncertain");
    Alcotest.(check string) "intent retained" proof (read evidence);
    Alcotest.(check string) "registry retained" (original ^ " ") (read path))

let provision_interrupted_before_allocation ?(point=M.Before_allocate) () =
  fixture (fun root ->
    let profile = `Assoc [("backend", s "codex"); ("label", s "Interrupted")] in
    (match Unix.fork () with
    | 0 ->
        let checkpoint actual = if actual = point then Unix.kill (Unix.getpid ()) Sys.sigkill in
        ignore (M.write_profile ~checkpoint ~provision:true ~root ~expected_revision:None ~profile ());
        Unix._exit 125
    | pid -> Alcotest.(check bool) "killed before allocation" true
        (snd (Unix.waitpid [] pid) = Unix.WSIGNALED Sys.sigkill));
    Alcotest.(check bool) "no allocated root" false
      (Array.exists (String.starts_with ~prefix:"profile-p-") (Sys.readdir root));
    Alcotest.(check bool) "second caller refused" true
      (M.provision_profile ~root ~expected_revision:None ~profile = Error "profile-publication-uncertain");
    Alcotest.(check bool) "stale acknowledgement refuses" true
      (M.recover_provision ~root ~expected:(String.make 64 '0') = Error "profile-publication-uncertain");
    let proof_path = Filename.concat root ".backend-profiles.provision-intent" in
    let proof_bytes = read proof_path and proof_stat = Unix.lstat proof_path in
    let digest = Digestif.SHA256.(to_hex (digest_string proof_bytes)) in
    let root_stat = Unix.lstat root in
    let old_proof = Printf.sprintf "%d:%d:%d:%d:%s" root_stat.Unix.st_dev root_stat.Unix.st_ino proof_stat.Unix.st_dev proof_stat.Unix.st_ino digest in
    let replacement = Filename.concat root "replacement-intent" in
    write replacement proof_bytes;
    Unix.rename replacement proof_path;
    Alcotest.(check bool) "same-content replacement refuses stale proof" true
      (M.recover_provision ~root ~expected:old_proof = Error "profile-publication-uncertain");
    Alcotest.(check bool) "explicit recovery proves no publication" true
      (recover_provision root = Ok M.Unpublished_aborted);
    Alcotest.(check bool) "future explicit attempt allowed" true
      (Result.is_ok (M.provision_profile ~root ~expected_revision:None ~profile)))

let provision_mkdir_collision () =
  fixture (fun root ->
      let profile label = `Assoc [ ("backend", s "codex"); ("label", s label) ] in
      let revision =
        match M.provision_profile ~root ~expected_revision:None ~profile:(profile "Neighbour") with
        | Error code -> Alcotest.fail code
        | Ok (revision, _) ->
            Alcotest.(check bool) "confirmed provision reconciled" true
              (recover_provision root = Ok M.Published_reconciled);
            revision
      in
      let id = "p-0123456789abcdef" in
      let occupied = Filename.concat root ("profile-" ^ id) in
      Unix.mkdir occupied 0o700;
      write (Filename.concat occupied "witness") "preexisting unregistered directory";
      let rec inventory path =
        let st = Unix.lstat path in
        let content =
          if st.Unix.st_kind = Unix.S_DIR then
            `Directory (Sys.readdir path |> Array.to_list |> List.sort String.compare)
          else `File (read path)
        in
        (path, st.Unix.st_dev, st.Unix.st_ino, content)
        :: (match content with
            | `Directory names -> List.concat_map (fun name -> inventory (Filename.concat path name)) names
            | `File _ -> [])
      in
      let before = inventory root in
      let used = ref false in
      let result = M.write_profile ~new_id:(fun () -> used := true; id) ~root
        ~expected_revision:(Some revision) ~provision:true ~profile:(profile "Different") () in
      Alcotest.(check bool) "unregistered destination reaches the mkdir guard" true
        (!used && result = Error "profile-already-exists");
      Alcotest.(check bool) "registry and neighbouring trees retain names, inodes and bytes" true
        (inventory root = before))

let () =
  Alcotest.run
    ~argv:[| Sys.argv.(0) |]
    "backend migration"
    [
      ( "host-only migration",
        List.map
          (fun (name, f) -> Alcotest.test_case name `Quick f)
          [
            ("dual backend and repeat", dual_backend);
            ("missing roots remain absent", missing_agent_roots);
            ("24 Unicode characters", unicode);
            ("strict legacy schema", invalid_sources);
            ("full converted validation", invalid_conversion);
            ("trimmed labels cannot introduce id ambiguity", trimmed_name_collision);
            ("derived roots fit native limit", derived_root_limit);
            ("interrupted no-clobber link recovery", interrupted_link);
            ("source and config custody", custody);
            ("physical alias and writable agent roots", unsafe_agent_roots);
            ("existing foreign targets", existing_targets);
            ("all 64 dual-backend aliases migrate", capacity);
             ("concurrent no-clobber publication", concurrent);
             ("live publisher cannot be recovered", live_publication);
             ("legacy switch crash blocks migration", legacy_switch_crash_keeps_migration_blocked);
             ("foreign legacy switch evidence blocks migration", legacy_switch_foreign_entry_fails_closed);
             ("unsafe migration lock refused", unsafe_migration_lock);
            ("preexisting retirement marker refuses migration", already_retired);
             ("marker publication failures retain registry", marker_failures);
             ("recorded marker interruption is resumable", recorded_marker_failure);
            ("HTTP migration forbidden", host_only);
            ("prepublication rollback and racing target", publication_boundaries);
            ("published registry readable before acknowledgement", publication_is_readable_before_ack);
            ("postpublication durability uncertainty", uncertain_publication);
            ("foreign custody predicate", custody_predicate);
            ("missing and aliased Mesh root", missing_or_aliased_mesh_root);
            ("explicit first-create recovery requires witnessed state", first_create_interruption);
            ("provision killed before first link", provision_interruption ~replace_stage:false ~append:false ~point:Before_publish);
            ("provision killed before allocation", (fun () -> provision_interrupted_before_allocation ()));
            ("provision killed after intent rename", provision_interrupted_before_allocation ~point:M.After_intent_publish);
            ("provision refuses changed registry at recovery", provision_recovery_refuses_changed_registry);
            ("provision refuses replaced root", provision_recovery_refuses_replaced_root);
            ("inspection is read-only", provision_inspection_is_read_only);
            ("combined first recovery before publication", provision_combined_first_recovery M.Before_publish);
            ("combined first recovery after publication", provision_combined_first_recovery M.After_publish);
            ("stale acknowledgement preserves new first intent", provision_old_ack_refuses_new_first_intent);
            ("first recovery interrupted before publication", provision_first_recovery_interruption M.Before_publish);
            ("first recovery interrupted after publication", provision_first_recovery_interruption M.After_publish);
            ("receipt refuses altered operation binding", provision_receipt_refuses_changed_operation);
            ("explicit receipt cleanup preserves active intent", provision_receipt_cleanup);
            ("recovery resumes after receipt", provision_receipt_interruption `Receipt_published);
            ("recovery resumes after intent removal", provision_receipt_interruption `Intent_removed);
            ("old acknowledgement cannot clear a newer provision", provision_old_acknowledgement_cannot_resolve_new_intent);
            ("provision killed after first link", provision_interruption ~replace_stage:false ~append:false ~point:After_publish);
            ("provision killed before append rename", provision_interruption ~replace_stage:false ~append:true ~point:Before_publish);
            ("unpublished foreign stage is preserved", provision_interruption ~replace_stage:true ~append:true ~point:Before_publish);
            ("provision killed after append rename", provision_interruption ~replace_stage:false ~append:true ~point:After_publish);
            ("provision refuses a real mkdir collision", provision_mkdir_collision);
          ] );
    ]
