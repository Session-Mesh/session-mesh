(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module C = Mesh_project_codec
module S = Mesh_project_store
module U = Yojson.Basic.Util

let str s = `String s
let uid n = Printf.sprintf "00000000-0000-4000-8000-%012d" n
let check label expected actual = Alcotest.(check string) label expected actual
let value r k = U.to_string (U.member k r)

let bytes root =
  Ptyhost_blackbox.file_contents (Filename.concat root "projects.json")

let write root text =
  let fd =
    Unix.openfile
      (Filename.concat root "projects.json")
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ]
      0o600
  in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () -> ignore (Unix.write_substring fd text 0 (String.length text)))

let with_store ?hook f =
  let root =
    Filename.temp_dir
      ~temp_dir:(Test_scratch.short_temp_root ())
      "project-store-" ""
  in
  let seq = ref 100 in
  let machine () =
    incr seq;
    uid !seq
  in
  let store = S.make ?hook ~root ~boot:"boot1" ~machine () in
  Fun.protect
    ~finally:(fun () -> Ptyhost_blackbox.remove_tree root)
    (fun () -> f root store)

let call store op fields =
  S.run store ~isolated:false ([ ("op", str op); ("version", `Int 1) ] @ fields)

let create store ?(revision = "cfg1_missing") ?(title = "First") n =
  call store "project_create"
    [
      ("boot", str "boot1");
      ("expected_revision", str revision);
      ("request_id", str (uid n));
      ("project", `Assoc [ ("title", str title) ]);
    ]

let settings store revision n patch =
  call store "project_settings"
    [
      ("boot", str "boot1");
      ("expected_revision", str revision);
      ("request_id", str (uid n));
      ("project_id", str (uid 1));
      ("patch", `Assoc patch);
    ]

let status store n =
  call store "project_status"
    [ ("request_id", str (uid n)); ("project_id", str (uid 1)) ]

let check_capability_limits store =
  let limits = U.member "limits" (call store "project_capabilities" []) in
  List.iter (fun (key, expected) ->
      Alcotest.(check bool) ("native capability " ^ key) true
        (U.member key limits = `Int expected))
    [ "request_bytes", 131072; "reply_bytes", 196608; "config_bytes", 2097152;
      "max_folders", 100; "max_sources", 20; "max_source_changes", 40 ]

let lifecycle () =
  with_store (fun root store ->
      check_capability_limits store;
      let empty = call store "project_list" [] in
      check "missing" "uninitialized" (value empty "status");
      Alcotest.(check bool)
        "no machine identity" true
        (U.member "machine_id" empty = `Null);
      let created = create store 1 in
      check "created" "ok" (value created "status");
      let first = bytes root in
      let edited =
        settings store (value created "revision") 2
          [
            ("title", str "Renamed");
            ("folders", `List [ str "/one"; str "/two" ]);
          ]
      in
      check "updated" "updated" (value edited "result");
      let latest = bytes root in
      let replay = create store 1 in
      check "original replay" "replayed" (value replay "result");
      check "replay byte unchanged" latest (bytes root);
      let bad = create store ~title:"Different" 1 in
      check "immutable" "immutable-identity" (value bad "code");
      check "unchanged" latest (bytes root);
      let stale =
        settings store (value created "revision") 3 [ ("title", str "Lost") ]
      in
      check "stale" "revision-conflict" (value stale "code");
      check "conflict exposes consumed current revision"
        (value edited "revision") (value stale "revision");
      let last_replay =
        settings store "obsolete" 2
          [
            ("title", str "Renamed");
            ("folders", `List [ str "/one"; str "/two" ]);
          ]
      in
      check "settings replay" "replayed" (value last_replay "result");
      check "create confirmed" "confirmed"
        (value (status store 1) "intent_state");
      check "latest settings confirmed" "confirmed"
        (value (status store 2) "intent_state");
      let edited2 =
        settings store (value edited "revision") 3
          [ ("description", str "Detail") ]
      in
      check "second settings" "ok" (value edited2 "status");
      check "old settings unknown" "unknown"
        (value (status store 2) "intent_state");
      Alcotest.(check bool) "real bytes changed" true (first <> bytes root);
      let restarted =
        S.make ~root ~boot:"boot2"
          ~machine:(fun () -> failwith "identity should persist")
          ()
      in
      let listed = call restarted "project_list" [] in
      check "restart machine stable"
        (value created "machine_id")
        (value listed "machine_id");
      let stale_boot =
        call restarted "project_create"
          [
            ("boot", str "boot1");
            ("expected_revision", str (value listed "revision"));
            ("request_id", str (uid 4));
            ("project", `Assoc [ ("title", str "No") ]);
          ]
      in
      check "stale boot" "stale-host" (value stale_boot "code"))

let fault_boundaries () =
  List.iter
    (fun stage ->
      let fail = ref false in
      with_store
        ~hook:(fun at ->
          if !fail && at = stage then
            raise (Unix.Unix_error (Unix.EIO, "test-stage", "")))
        (fun root store ->
          let first = create store 1 in
          let before = bytes root in
          fail := true;
          let r =
            settings store (value first "revision") 2 [ ("title", str "After") ]
          in
          if List.mem stage [ S.Published; S.Directory_synced ] then (
            check "post-publication uncertain" "uncertain" (value r "status");
            Alcotest.(check bool) "published bytes" true (before <> bytes root);
            check "reconciled receipt" "confirmed"
              (value (status store 2) "intent_state"))
          else (
            check "prepublication unavailable" "unavailable" (value r "status");
            check "old bytes" before (bytes root));
          Alcotest.(check bool)
            "lock released after worker finish" false
            (Sys.file_exists (Filename.concat root "projects.lock"))))
    [ S.Locked; S.Read; S.Temp_synced; S.Published; S.Directory_synced ]

let refusals () =
  with_store (fun root store ->
      let first = create store 1 in
      let before = bytes root in
      let lock = Filename.concat root "projects.lock" in
      let fd =
        Unix.openfile lock [ Unix.O_CREAT; Unix.O_EXCL; Unix.O_WRONLY ] 0o600
      in
      Unix.close fd;
      check "dead writer busy" "busy"
        (value
           (settings store (value first "revision") 2 [ ("title", str "No") ])
           "status");
      check "inflight unknown remains pending" "pending"
        (value (status store 9) "intent_state");
      Unix.unlink lock;
      let original = Yojson.Basic.from_string before in
      let unknown = `Assoc (("future", `Bool true) :: C.obj original) in
      write root (C.encode unknown);
      let bad = bytes root in
      ignore (settings store (value first "revision") 2 [ ("title", str "No") ]);
      check "unknown top level exact" bad (bytes root);
      write root before;
      Unix.chmod (Filename.concat root "projects.json") 0o644;
      check "unsafe file" "unavailable"
        (value (call store "project_list" []) "status");
      check "unsafe exact" before (bytes root);
      Unix.chmod (Filename.concat root "projects.json") 0o600;
      let iso =
        S.run store ~isolated:true
          [ ("op", str "project_create"); ("version", `Int 1) ]
      in
      check "identity split" "unsupported" (value iso "status");
      check "identity split no writes" before (bytes root);
      let dup =
        S.run store ~isolated:false
          [
            ("op", str "project_list");
            ("op", str "project_create");
            ("version", `Int 1);
          ]
      in
      check "duplicate refused" "refused" (value dup "status"))

let metadata () =
  with_store (fun root store ->
      let source =
        `Assoc
          [
            ("id", str "roster");
            ("kind", str "roster");
            ("label", str "Board");
            ("board_path", str "/authored/board");
            ( "channels",
              `List
                [
                  `Assoc
                    [
                      ("id", str "general");
                      ("label", str "General");
                      ("native_id", str "opaque");
                    ];
                ] );
          ]
      in
      let repo =
        `Assoc
          [
            ("url", str "https://example.org/a");
            ("local_path", str "/authored/repo");
            ("primary_ref", str "refs/heads/main");
            ("branch", str "main");
            ("readme_url", str "https://example.org/readme");
          ]
      in
      let project =
        `Assoc
          [
            ("id", str (uid 1));
            ("title", str "Imported");
            ("sources", `List [ source ]);
            ("repository", repo);
            ( "sessions",
              `List [ `Assoc [ ("name", str "old"); ("created", `Int 5) ] ] );
            ( "participations",
              `List
                [
                  `Assoc
                    [
                      ("id", str "history");
                      ("recorded_relation", str "historical");
                      ( "target",
                        `Assoc
                          [
                            ("kind", str "history");
                            ("agent", str "codex");
                            ("conversation_id", str "conversation");
                          ] );
                      ( "work_refs",
                        `List
                          [
                            `Assoc
                              [
                                ("source_id", str "roster");
                                ("kind", str "task");
                                ("native_id", str "N4");
                              ];
                          ] );
                    ];
                ] );
          ]
      in
      let config =
        `Assoc
          [
            ("kind", str "mesh-project-config");
            ("schema_version", `Int 2);
            ("features", `List [ str "project-metadata/1" ]);
            ("machine_id", str "legacy-machine");
            ("projects", `List [ project ]);
          ]
      in
      write root (C.encode config);
      let listed = call store "project_list" [] in
      let r =
        settings store (value listed "revision") 2
          [
            ("title", str "Changed");
            ("repository", `Assoc [ ("url", str "https://example.org/new") ]);
            ( "source_changes",
              `List
                [
                  `Assoc
                    [
                      ("type", str "put");
                      ("id", str "roster");
                      ("label", str "New label");
                    ];
                ] );
          ]
      in
      check "metadata update" "ok" (value r "status");
      let saved =
        U.to_list (U.member "projects" (Yojson.Basic.from_string (bytes root)))
        |> List.hd
      in
      List.iter
        (fun k ->
          Alcotest.(check bool)
            k true
            (C.canonical (U.member k project) = C.canonical (U.member k saved)))
        [ "sessions"; "participations" ];
      let saved_repo = U.member "repository" saved in
      List.iter
        (fun k ->
          Alcotest.(check bool)
            k true
            (C.canonical (U.member k repo) = C.canonical (U.member k saved_repo)))
        [ "local_path"; "primary_ref"; "branch"; "readme_url" ];
      let saved_source = U.to_list (U.member "sources" saved) |> List.hd in
      List.iter
        (fun k ->
          Alcotest.(check bool)
            k true
            (C.canonical (U.member k source)
            = C.canonical (U.member k saved_source)))
        [ "board_path"; "channels" ];
      Alcotest.(check bool)
        "no invented creation history" true
        (U.member "creation" saved = `Null);
      let bad = `Assoc (("future", `Int 1) :: C.obj saved_source) in
      let saved =
        `Assoc
          (("sources", `List [ bad ])
          :: List.remove_assoc "sources" (C.obj saved))
      in
      let c = Yojson.Basic.from_string (bytes root) in
      write root
        (C.encode
           (`Assoc
              (("projects", `List [ saved ])
              :: List.remove_assoc "projects" (C.obj c))));
      let before = bytes root in
      ignore (settings store (value r "revision") 3 [ ("title", str "No") ]);
      check "unknown nested exact" before (bytes root))

let limits () =
  with_store (fun root store ->
      let first = create store 1 in
      let large = String.make 4090 'x' in
      let folder i = str ("/" ^ string_of_int i ^ large) in
      (* Config exceeds a frame but remains under the independent durable limit. *)
      let original = Yojson.Basic.from_string (bytes root) in
      let p = List.hd (U.to_list (U.member "projects" original)) in
      let p = `Assoc (("folders", `List (List.init 100 folder)) :: C.obj p) in
      let config =
        `Assoc
          (("projects", `List [ p ])
          :: List.remove_assoc "projects" (C.obj original))
      in
      write root (C.encode config);
      let listed = call store "project_list" [] in
      let detail = call store "project_read" [ ("project_id", str (uid 1)) ] in
      Alcotest.(check bool)
        "entire reply bounded" true
        (String.length (C.encode detail) <= C.reply_bytes);
      Alcotest.(check bool)
        "whole folders omitted" true
        (List.mem (str "folders")
           (U.to_list (U.member "omitted_fields" detail)));
      let updated =
        settings store (value listed "revision") 2
          [ ("title", str "Safe partial edit") ]
      in
      check "partial patch" "ok" (value updated "status");
      let saved =
        List.hd
          (U.to_list
             (U.member "projects" (Yojson.Basic.from_string (bytes root))))
      in
      Alcotest.(check bool)
        "omitted preserved" true
        (U.member "folders" p = U.member "folders" saved);
      let _ = first in
      let before = bytes root in
      write root (before ^ String.make C.config_bytes ' ');
      let oversized = bytes root in
      check "2MiB refused" "unavailable"
        (value (call store "project_list" []) "status");
      check "oversize unchanged" oversized (bytes root))

let compatibility_fixture () =
  let path =
    List.find Sys.file_exists
      [
        "fixtures/projects/n4-authored.json";
        "ocaml/test/fixtures/projects/n4-authored.json";
      ]
  in
  let original = C.parse_config (Ptyhost_blackbox.file_contents path) in
  let replace key value v =
    `Assoc ((key, value) :: List.remove_assoc key (C.obj v))
  in
  with_store (fun root store ->
      write root (C.encode original);
      let listed = call store "project_list" [] in
      let changed =
        call store "project_settings"
          [
            ("boot", str "boot1");
            ("expected_revision", U.member "revision" listed);
            ("request_id", str (uid 5));
            ("project_id", str "project_A");
            ("patch", `Assoc [ ("description", str "Independent patch") ]);
          ]
      in
      check "qualified authored-metadata fixture writes" "ok" (value changed "status");
      let saved =
        List.hd (U.to_list (U.member "projects" (C.parse_config (bytes root))))
      in
      let before = List.hd (U.to_list (U.member "projects" original)) in
      List.iter
        (fun k ->
          Alcotest.(check bool)
            k true
            (C.canonical (U.member k saved) = C.canonical (U.member k before)))
        [ "sources"; "sessions"; "participations" ];
      let bad_configs =
        [
          replace "features" (`List [ str "future/1" ]) original;
          replace "projects"
            (`List [ replace "future" (`Bool true) before ])
            original;
          replace "projects"
            (`List
               [
                 replace "participations"
                   (`List
                      [
                        `Assoc
                          [
                            ("id", str "p");
                            ("recorded_relation", str "active");
                            ( "target",
                              `Assoc
                                [
                                  ("kind", str "history");
                                  ("agent", str "codex");
                                  ("conversation_id", str "opaque");
                                ] );
                            ( "work_refs",
                              `List
                                (List.init 2 (fun _ ->
                                     `Assoc
                                       [
                                         ("source_id", str "chat");
                                         ("kind", str "channel");
                                         ("native_id", str "same");
                                       ])) );
                          ];
                      ])
                   before;
               ])
            original;
        ]
      in
      List.iter
        (fun cfg ->
          write root (C.encode cfg);
          let bytes_before = bytes root in
          let result =
            call store "project_settings"
              [
                ("boot", str "boot1");
                ("expected_revision", U.member "revision" changed);
                ("request_id", str (uid 6));
                ("project_id", str "project_A");
                ("patch", `Assoc [ ("title", str "No") ]);
              ]
          in
          Alcotest.(check bool)
            "invalid fixture refused" true
            (U.member "status" result <> str "ok");
          check "invalid fixture byte unchanged" bytes_before (bytes root))
        bad_configs);
  (* Legacy common whitespace is accepted as context and left semantically
     unchanged when a different field is patched during schema upgrade. *)
  with_store (fun root store ->
      let p =
        `Assoc
          [
            ("id", str (uid 1));
            ("title", str "Line\nBreak");
            ("sources", `List []);
            ( "sessions",
              `List
                [ `Assoc [ ("name", str "\t"); ("created", `Float 12.125) ] ] );
          ]
      in
      let cfg =
        `Assoc
          [
            ("kind", str "mesh-project-config");
            ("schema_version", `Int 1);
            ("machine_id", str "legacy");
            ("projects", `List [ p ]);
          ]
      in
      write root (C.encode cfg);
      let listed = call store "project_list" [] in
      check "schema1 patch" "ok"
        (value
           (settings store (value listed "revision") 2
              [ ("description", str "Added") ])
           "status");
      let saved =
        List.hd (U.to_list (U.member "projects" (C.parse_config (bytes root))))
      in
      Alcotest.(check bool)
        "legacy title preserved" true
        (U.member "title" saved = U.member "title" p))

let max_projects () =
  with_store (fun root store ->
      let p i =
        `Assoc
          [
            ("id", str ("p" ^ string_of_int i));
            ("title", str (String.make 240 '\t'));
            ("sources", `List []);
            ("sessions", `List []);
          ]
      in
      let cfg =
        `Assoc
          [
            ("kind", str "mesh-project-config");
            ("schema_version", `Int 1);
            ("machine_id", str "bounded");
            ("projects", `List (List.init 100 p));
          ]
      in
      write root (C.encode cfg);
      let before = bytes root in
      let listed = call store "project_list" [] in
      Alcotest.(check int)
        "all 100 summaries" 100
        (U.to_int (U.member "total" listed));
      Alcotest.(check bool)
        "whole escaped summary envelope fits" true
        (String.length (C.encode listed) <= C.reply_bytes);
      check "capacity refusal" "capacity"
        (value (create store ~revision:(value listed "revision") 1) "code");
      check "capacity leaves exact old bytes" before (bytes root))

let unsafe_identities () =
  with_store (fun root store ->
      let first = create store 1 in
      let before = bytes root in
      let file = Filename.concat root "projects.json"
      and other = Filename.concat root "original" in
      Unix.rename file other;
      Unix.symlink other file;
      check "symlink refuses" "unavailable"
        (value (call store "project_list" []) "status");
      check "target unchanged" before (Ptyhost_blackbox.file_contents other);
      Unix.unlink file;
      Unix.link other file;
      check "hardlink refuses" "unavailable"
        (value (call store "project_list" []) "status");
      Unix.unlink file;
      Unix.rename other file;
      let linked = root ^ "-link" in
      Unix.symlink root linked;
      Fun.protect
        ~finally:(fun () -> Unix.unlink linked)
        (fun () ->
          let via_link =
            S.make ~root:linked ~boot:"boot1" ~machine:(fun () -> "unused") ()
          in
          check "symlink root refuses" "unavailable"
            (value (call via_link "project_list" []) "status"));
      let absent =
        S.make
          ~root:(Filename.concat root "absent")
          ~boot:"boot1"
          ~machine:(fun () -> "unused")
          ()
      in
      check "missing root local unavailable" "unavailable"
        (value (call absent "project_list" []) "status");
      Alcotest.(check bool)
        "root never created" false
        (Sys.file_exists (Filename.concat root "absent"));
      let malformed = String.make 200 '[' ^ String.make 200 ']' in
      write root malformed;
      check "deep config bounded refusal" "unavailable"
        (value (call store "project_list" []) "status");
      check "deep config unchanged" malformed (bytes root);
      let _ = first in
      ())

let unicode_normalization () =
  let create fields = C.normalized_create (`Assoc fields) in
  let ordinary = create [ ("title", str "Name") ] in
  Alcotest.(check bool)
    "Unicode trim and optional empty canonicalize" true
    (ordinary
    = create
        [
          ("title", str "\194\160Name\227\128\128");
          ("description", str "\194\160");
          ("folders", `List []);
        ]);
  let refuses f =
    try
      ignore (f ());
      Alcotest.fail "invalid codec value accepted"
    with C.Invalid _ -> ()
  in
  refuses (fun () -> create [ ("title", str "\194\160") ]);
  refuses (fun () -> create [ ("title", str "Bad\255") ]);
  ignore
    (create
       [
         ( "title",
           str (String.concat "" (List.init 120 (fun _ -> "\240\159\152\128")))
         );
       ]);
  refuses (fun () ->
      create
        [
          ( "title",
            str (String.concat "" (List.init 121 (fun _ -> "\240\159\152\128")))
          );
        ]);
  refuses (fun () ->
      create
        [
          ("title", str "URL");
          ("repository", `Assoc [ ("url", str "https://example.test/\194\160") ]);
        ]);
  refuses (fun () ->
      create
        [
          ("title", str "URL");
          ( "repository",
            `Assoc [ ("url", str "https://user:secret@example.test/") ] );
        ])

let in_flight_without_lock_visibility () =
  let holder = ref None and root_holder = ref "" and observed = ref None in
  let hook stage =
    if stage = S.Locked then (
      let lock = Filename.concat !root_holder "projects.lock"
      and hidden = Filename.concat !root_holder "held-lock" in
      Unix.rename lock hidden;
      Fun.protect
        ~finally:(fun () -> Unix.rename hidden lock)
        (fun () -> observed := Some (status (Option.get !holder) 1)))
  in
  with_store ~hook (fun root store ->
      holder := Some store;
      root_holder := root;
      let created = create store 1 in
      check "create completes" "ok" (value created "status");
      check "admitted intent never absent during lock visibility gap" "pending"
        (value (Option.get !observed) "intent_state"))

let startup_default () =
  let previous = Sys.getenv_opt "MESH_CONF_DIR" in
  Fun.protect
    ~finally:(fun () ->
      Unix.putenv "MESH_CONF_DIR" (Option.value ~default:"" previous))
    (fun () ->
      Unix.putenv "MESH_CONF_DIR" "";
      let expected =
        Filename.concat (Unix.getpwuid (Unix.geteuid ())).Unix.pw_dir
          ".config/session-mesh"
      in
      check "empty is default" expected (S.startup_root ());
      Unix.putenv "MESH_CONF_DIR" "/fixed/project-config";
      check "explicit fixed root" "/fixed/project-config" (S.startup_root ()))

let byte_capacity () =
  with_store (fun root store ->
      let folders count =
        `List
          (List.init count (fun i ->
               str ("/" ^ string_of_int i ^ String.make 4088 'x')))
      in
      let p pid fs =
        `Assoc
          [
            ("id", str pid);
            ("title", str "Project");
            ("sources", `List []);
            ("sessions", `List []);
            ("folders", folders fs);
          ]
      in
      let cfg =
        `Assoc
          [
            ("kind", str "mesh-project-config");
            ("schema_version", `Int 2);
            ( "features",
              `List [ str "project-metadata/1"; str "project-workspace/1" ] );
            ("machine_id", str "bounded");
            ( "projects",
              `List
                (p (uid 1) 0
                :: List.init 5 (fun i -> p ("p" ^ string_of_int i) 100)) );
          ]
      in
      write root (C.encode cfg);
      let before = bytes root in
      Alcotest.(check bool)
        "large valid durable fixture" true
        (String.length before < C.config_bytes && String.length before > 2000000);
      let listed = call store "project_list" [] in
      let rejected =
        settings store (value listed "revision") 2 [ ("folders", folders 20) ]
      in
      check "aggregate byte capacity" "capacity" (value rejected "code");
      check "no data or receipt eviction" before (bytes root))

let full_source_replacement () =
  with_store (fun root store ->
      let source prefix i =
        `Assoc [ ("id", str (prefix ^ string_of_int i)); ("kind", str "roster");
          ("label", str ("Reference " ^ string_of_int i)) ]
      in
      let old_sources = List.init 20 (source "old_") in
      let created = call store "project_create"
          [ ("boot", str "boot1"); ("expected_revision", str "cfg1_missing");
            ("request_id", str (uid 1));
            ("project", `Assoc [ ("title", str "Full references"); ("sources", `List old_sources) ]) ] in
      check "full create" "ok" (value created "status");
      let removals = List.init 20 (fun i -> `Assoc [ ("type", str "remove"); ("id", str ("old_" ^ string_of_int i)) ]) in
      let puts = List.init 20 (fun i -> `Assoc (("type", str "put") :: C.obj (source "new_" i))) in
      let updated = settings store (value created "revision") 2 [ ("source_changes", `List (removals @ puts)) ] in
      check "all20 replaced by20 in one mutation" "ok" (value updated "status");
      let read = call store "project_read" [ ("project_id", str (uid 1)) ] in
      let actual = U.member "sources" (U.member "project" read) |> U.to_list in
      Alcotest.(check int) "final source bound retained" 20 (List.length actual);
      List.iteri (fun i item -> check "new source" ("new_" ^ string_of_int i) (value item "id")) actual;
      let before = bytes root in
      let extra = `Assoc (("type", str "put") :: C.obj (source "extra_" 1)) in
      let refused = settings store (value updated "revision") 3 [ ("source_changes", `List [extra]) ] in
      check "source-change state refused" "refused" (value refused "status");
      check "source bound preserves bytes" before (bytes root))

let typed_settings () =
  with_store (fun root store ->
      let created = create store 1 in
      let plan = `Assoc [("repository", `Bool true); ("source_ids", `List [])] in
      let changed = settings store (value created "revision") 2
        [("repository", `Assoc [("url", str "https://example.test/repo"); ("local_path", str "/tmp/repo"); ("primary_ref", str "refs/heads/main")]);
         ("observation", plan)] in
      check "typed settings accepted" "ok" (value changed "status");
      let saved = bytes root in
      let projection = call store "project_read" [("project_id", str (uid 1)); ("settings", `Assoc [("kind", str "project")])] in
      Alcotest.(check bool) "plan projected" true (U.member "plan" (U.member "observation_settings" projection) = plan);
      let refused = settings store (value changed "revision") 3 [("repository", `Assoc [("url", `Null)])] in
      check "URL required" "refused" (value refused "status");
      check "refusal atomic" saved (bytes root);
      let disabled = settings store (value changed "revision") 4 [("repository", `Null); ("observation", `Null)] in
      check "atomic disable" "ok" (value disabled "status");
      Alcotest.(check bool) "disable preserves observation declaration" true
        (List.mem (str "project-observation/1") (U.to_list(U.member "features" (Yojson.Basic.from_string(bytes root)))));
      let selector = `Assoc ["kind",str "board";"path",str "/tmp/board.json"] in
      let selected = settings store (value disabled "revision") 5
          ["source_changes",`List [`Assoc ["type",str "put";"id",str "roster";"kind",str "roster";"label",str "Saved label";"url",str "https://example.test/source";"selector",selector]];
           "observation",`Assoc ["repository",`Bool false;"source_ids",`List [str "roster"]]] in
      check "atomic source selector and plan" "ok" (value selected "status");
      let source = call store "project_read" ["project_id",str(uid 1);"settings",`Assoc ["kind",str "source";"source_id",str "roster"]] in
      let source=U.member "source" (U.member "observation_settings" source) in
      Alcotest.(check bool) "source scoped selector projected" true (U.member "selector" source=selector);
      check "source label projected" "Saved label" (value source "label");
      let saved=bytes root in
      let refused=settings store (value selected "revision") 6 ["source_changes",`List [`Assoc ["type",str "selector";"id",str "roster";"selector",`Null]]] in
      check "enabled source cannot lose selector" "refused" (value refused "status");
      check "invalid source final state leaves bytes" saved (bytes root);
      let cleared=settings store (value selected "revision") 7 ["source_changes",`List [`Assoc ["type",str "selector";"id",str "roster";"selector",`Null]];"observation",`Null] in
      check "atomic selector clear and disable" "ok" (value cleared "status");
      let source=call store "project_read" ["project_id",str(uid 1);"settings",`Assoc ["kind",str "source";"source_id",str "roster"]] in
      let source=U.member "source" (U.member "observation_settings" source) in
      check "selector only change preserves label" "Saved label" (value source "label");
      check "selector only change preserves URL" "https://example.test/source" (value source "url"))

let pipeline_selector_settings () =
  with_store (fun root store ->
      let selector root task = `Assoc ["kind",str "pipeline";"root",str root;"task",str task] in
      let initial = selector "/tmp/first-pipeline" "mesh-roster-observation" in
      let source label selected = `Assoc ["type",str "put";"id",str "roster";
        "kind",str "roster";"label",str label;"selector",selected] in
      let created = create store 1 in
      let added = settings store (value created "revision") 2
        ["source_changes", `List [source "Actual label" initial]] in
      check "pipeline source put accepted" "ok" (value added "status");
      let read_source () =
        let reply = call store "project_read" ["project_id",str(uid 1);
          "settings",`Assoc ["kind",str "source";"source_id",str "roster"]] in
        U.member "source" (U.member "observation_settings" reply) in
      Alcotest.(check bool) "pipeline selector readback" true
        (U.member "selector" (read_source ()) = initial);
      let replacement = selector "/tmp/second-pipeline" "another-task" in
      let changed = settings store (value added "revision") 3 ["source_changes", `List [
        `Assoc ["type",str "selector";"id",str "roster";"selector",replacement]]] in
      check "selector-only pipeline change accepted" "ok" (value changed "status");
      let readback = read_source () in
      Alcotest.(check bool) "replacement selector readback" true
        (U.member "selector" readback = replacement);
      check "real source label retained" "Actual label" (value readback "label");
      let before = bytes root in
      List.iteri (fun index invalid ->
        let refused = settings store (value changed "revision") (10+index)
          ["source_changes", `List [source "Actual label" invalid]] in
        check "invalid selector refused" "refused" (value refused "status");
        check "invalid selector does not write" before (bytes root))
        [selector "relative" "task"; selector "/tmp/pipeline" "";
         selector "/tmp/pipeline" "Bad_task";
         `Assoc ["kind",str "pipeline";"root",str "/tmp/pipeline";"task",str "task";"extra",str "closed"]];
      let refused = settings store (value changed "revision") 20
        ["source_changes", `List [source "" initial]] in
      check "actual empty label still refused" "refused" (value refused "status");
      check "actual empty label leaves bytes" before (bytes root))

let session_tools () =
  with_store (fun root store ->
      let created = create store 1 in
      let machine = U.member "machine_id" created in
      let initial = Yojson.Basic.from_string (bytes root) in
      let initial_project = List.hd (U.to_list (U.member "projects" initial)) in
      let authored = `Assoc (("description", str "Preserve authored context") ::
          ("participations", `List [`Assoc ["id", str "saved-role"; "recorded_relation", str "saved";
            "target", `Assoc ["kind", str "mesh"; "name", str "other"; "created", `Int 12; "machine_id", str "foreign"]]]) :: C.obj initial_project) in
      write root (C.encode (`Assoc (("projects", `List [authored]) :: List.remove_assoc "projects" (C.obj initial))));
      let created = call store "project_list" [] in
      let reference at = `Assoc ["machine_id", machine; "name", str "same"; "created", at] in
      let change kind reference = `Assoc ["type", str kind; "session", reference] in
      let mutate revision n changes = settings store revision n ["session_changes", `List changes] in
      let read () = call store "project_read" ["project_id", str (uid 1)] in
      let refs () = U.member "sessions" (U.member "project" (read ())) |> U.to_list in
      let original = List.hd (U.to_list (U.member "projects" (Yojson.Basic.from_string (bytes root)))) in
      ignore (C.patch original (`Assoc ["session_changes", `List [change "attach" (reference (`Int 123))]]));
      let distinct = C.patch original (`Assoc ["session_changes", `List [
          change "attach" (reference (`Int 9007199254740992));
          change "attach" (reference (`Int 9007199254740993))]]) in
      Alcotest.(check int) "integer identities never collapse through float rounding" 2 (List.length (U.to_list (U.member "sessions" distinct)));
      let first = mutate (value created "revision") 2 [change "attach" (reference (`Int 123))] in
      check "attach exact identity" "ok" (value first "status");
      let persisted = List.hd (U.to_list (U.member "projects" (Yojson.Basic.from_string (bytes root)))) in
      List.iter (fun (key, old) -> if key <> "sessions" then
          Alcotest.(check bool) ("preserve " ^ key) true (C.canonical (U.member key persisted) = C.canonical old)) (C.obj authored);
      Alcotest.(check int) "bounded owner read" 1 (List.length (refs ()));
      let duplicate = mutate (value first "revision") 3 [change "attach" (reference (`Float 123.))] in
      check "numeric-equivalent duplicate" "ok" (value duplicate "status");
      Alcotest.(check int) "deduplicated" 1 (List.length (refs ()));
      let replaced = mutate (value duplicate "revision") 4 [change "attach" (reference (`Int 124))] in
      Alcotest.(check int) "same name distinct incarnation" 2 (List.length (refs ()));
      let before = bytes root in
      let stale = mutate (value duplicate "revision") 5 [change "detach" (reference (`Int 123))] in
      check "revision checked" "conflict" (value stale "status");
      check "conflict leaves bytes" before (bytes root);
      let malformed = `Assoc ["name", str "same"; "created", `Int 123] in
      check "machine required" "refused" (value (mutate (value replaced "revision") 6 [change "attach" malformed]) "status");
      check "invalid leaves bytes" before (bytes root);
      let detached = mutate (value replaced "revision") 7 [change "detach" (reference (`Int 123))] in
      check "detach exact tuple" "ok" (value detached "status");
      let remaining = refs () in
      Alcotest.(check bool) "replacement retained" true (List.length remaining = 1 && C.canonical (List.hd remaining) = C.canonical (reference (`Int 124)));
      let capability = call store "project_capabilities" [] in
      Alcotest.(check bool) "feature advertised" true (List.mem (str "project-session-tools/1") (U.to_list (U.member "features" capability)));
      let config = Yojson.Basic.from_string (bytes root) in
      let project = List.hd (U.to_list (U.member "projects" config)) in
      let full = List.init 100 (fun n -> reference (`Int n)) in
      let project = `Assoc (("sessions", `List full) :: List.remove_assoc "sessions" (C.obj project)) in
      write root (C.encode (`Assoc (("projects", `List [project]) :: List.remove_assoc "projects" (C.obj config))));
      let listed = call store "project_list" [] and before = bytes root in
      check "101 refused" "refused" (value (mutate (value listed "revision") 8 [change "attach" (reference (`Int 1000))]) "status");
      check "capacity leaves bytes" before (bytes root);
      Alcotest.(check int) "all100 read" 100 (List.length (refs ()));
      Alcotest.(check bool) "reply bound" true (String.length (C.encode (read ())) <= C.reply_bytes);
      let sessions = List.init 100 (fun n -> `Assoc ["name", str (String.make 240 'n'); "created", `Int n; "machine_id", str (String.make 80 'm')]) in
      let sources = List.init 20 (fun n -> `Assoc ["id", str ("s" ^ string_of_int n); "kind", str "other"; "label", str (String.make 240 's')]) in
      let folders = List.init 40 (fun n -> str ("/" ^ string_of_int n ^ String.make 4090 'f')) in
      let enlarged = `Assoc (("sessions", `List sessions) :: ("sources", `List sources) :: ("folders", `List folders) ::
          List.filter (fun (key, _) -> not (List.mem key ["sessions"; "sources"; "folders"])) (C.obj project)) in
      write root (C.encode (`Assoc (("projects", `List [enlarged]) :: List.remove_assoc "projects" (C.obj config))));
      let partial = read () in
      Alcotest.(check bool) "whole session field omitted, never truncated" true
        (U.member "sessions" (U.member "project" partial) = `Null && List.mem (str "sessions") (U.to_list (U.member "omitted_fields" partial)));
      Alcotest.(check int) "count survives omission" 100 (U.to_int (U.member "sessions_total" (U.member "project" partial)));
      Alcotest.(check bool) "partial reply bound" true (String.length (C.encode partial) <= C.reply_bytes))

let legacy_session_tools () =
  with_store (fun root store ->
      let config = `Assoc ["kind", str "mesh-project-config"; "schema_version", `Int 1;
        "machine_id", str "legacy-machine"; "projects", `List [`Assoc ["id", str "legacy"; "title", str "Legacy"]]] in
      write root (C.encode config);
      let before = bytes root in
      let read = call store "project_read" ["project_id", str "legacy"] in
      Alcotest.(check bool) "genuinely absent zero field projected" true (U.member "sessions" (U.member "project" read) = `List []);
      Alcotest.(check int) "legacy session count zero" 0 (U.to_int (U.member "sessions_total" (U.member "project" read)));
      check "read never rewrites legacy config" before (bytes root);
      let attached = call store "project_settings" ["boot", str "boot1"; "expected_revision", U.member "revision" read;
        "project_id", str "legacy"; "request_id", str (uid 2); "patch", `Assoc ["session_changes", `List [
          `Assoc ["type", str "attach"; "session", `Assoc ["machine_id", str "legacy-machine"; "name", str "live"; "created", `Int 1]]]]] in
      check "legacy first attachment succeeds" "ok" (value attached "status"))

let () =
  Alcotest.run "native project store"
    [
      ( "store",
        [
          Alcotest.test_case "exact session Tools attachment" `Quick session_tools;
          Alcotest.test_case "legacy first session Tools attachment" `Quick legacy_session_tools;
          Alcotest.test_case "typed observation settings" `Quick typed_settings;
          Alcotest.test_case "pipeline source selectors" `Quick pipeline_selector_settings;
          Alcotest.test_case "lifecycle CAS replay restart" `Quick lifecycle;
          Alcotest.test_case "real file fault boundaries" `Quick
            fault_boundaries;
          Alcotest.test_case "unsafe unknown lock duplicate refusal" `Quick
            refusals;
          Alcotest.test_case "authored metadata preservation" `Quick metadata;
          Alcotest.test_case "separate frame/config limits and partial patch"
            `Quick limits;
          Alcotest.test_case "qualified fixtures and strict metadata negatives"
            `Quick compatibility_fixture;
          Alcotest.test_case "complete escaped summaries and project capacity"
            `Quick max_projects;
          Alcotest.test_case "empty startup override uses persistent default"
            `Quick startup_default;
          Alcotest.test_case
            "in-flight intent remains pending without visible lock" `Quick
            in_flight_without_lock_visibility;
          Alcotest.test_case
            "Unicode normalization text limits and URL refusals" `Quick
            unicode_normalization;
          Alcotest.test_case "unsafe symlink hardlink missing and deep config"
            `Quick unsafe_identities;
          Alcotest.test_case
            "2MiB publication capacity preserves data and receipts" `Quick
            byte_capacity;
          Alcotest.test_case "replace all20 source references atomically" `Quick
            full_source_replacement;
        ] );
    ]
