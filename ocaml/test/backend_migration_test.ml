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

let write path bytes =
  Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_excl ] 0o600 path
    (fun channel -> output_string channel bytes)

let read path = In_channel.with_open_bin path In_channel.input_all

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
      Unix.unlink stage;
      write stage content;
      Unix.link stage (target root);
      refusal root "migration-target-exists";
      Alcotest.(check int) "recorded wrong inode never cleaned" 2
        (Unix.lstat stage).Unix.st_nlink);
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
          if status <> Unix.WEXITED 0 then
            Alcotest.(check bool)
              "losers refuse existing target" true
              (Yojson.Safe.Util.member "code" response
              = s "migration-target-exists"))
        results;
      Alcotest.(check string)
        "source unchanged under concurrency" original
        (read (source root));
      Alcotest.(check bool)
        "complete valid target" true
        (Result.is_ok (P.load ~root));
      Alcotest.(check int)
        "target has no staging link" 1 (Unix.stat (target root)).Unix.st_nlink;
      Alcotest.(check int)
        "only source, target and retirement marker" 3
        (Array.length (Sys.readdir root)))

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
        "no staging debris" 2
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
            ("preexisting retirement marker refuses migration", already_retired);
             ("marker publication failures retain registry", marker_failures);
             ("recorded marker interruption is resumable", recorded_marker_failure);
            ("HTTP migration forbidden", host_only);
            ("prepublication rollback and racing target", publication_boundaries);
            ("postpublication durability uncertainty", uncertain_publication);
            ("foreign custody predicate", custody_predicate);
            ("missing and aliased Mesh root", missing_or_aliased_mesh_root);
          ] );
    ]
