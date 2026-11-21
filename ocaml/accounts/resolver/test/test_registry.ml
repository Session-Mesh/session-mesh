(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

module R = Mesh_account_resolver

let uid = Unix.geteuid ()
let s text = `String text
let json = Yojson.Safe.to_string

let ok = function
  | Ok value -> value
  | Error (error : R.error) -> Alcotest.failf "%s: %s" error.code error.message

let refuses expected = function
  | Ok _ -> Alcotest.fail ("expected " ^ expected)
  | Error (error : R.error) ->
      Alcotest.(check string) "error code" expected error.code

let rec remove_tree path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Unix.chmod path 0o700;
      Array.iter
        (fun name -> remove_tree (Filename.concat path name))
        (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let with_root test () =
  let root =
    Unix.realpath (Filename.temp_dir ~perms:0o700 "mesh-native-resolver-" "")
  in
  Fun.protect ~finally:(fun () -> remove_tree root) (fun () -> test root)

let write path text =
  Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_trunc ] 0o600 path
    (fun channel -> output_string channel text)

let legacy root = Filename.concat root "accounts.json"
let native root = Filename.concat root "backend-profiles.json"
let load root = R.load ~uid ~file:(legacy root)
let path root name = Filename.concat root name

let mkdir root name =
  let folder = path root name in
  Unix.mkdir folder 0o700;
  folder

let profile ?(enabled = true) backend id label roots =
  `Assoc
    [
      ("id", s id);
      ("label", s label);
      ("backend", s backend);
      ("enabled", `Bool enabled);
      ("roots", `Assoc (List.map (fun (role, folder) -> (role, s folder)) roots));
    ]

let registry root profiles =
  write (native root)
    (json (`Assoc [ ("version", `Int 1); ("profiles", `List profiles) ]))

let native_profile ?(enabled = true) root backend id label name =
  let config = mkdir root name in
  let role, child =
    if backend = "codex" then ("state", "sessions") else ("history", "projects")
  in
  let history = mkdir config child in
  profile ~enabled backend id label [ ("config", config); (role, history) ]

let declare_legacy root id =
  let folder = path root (id ^ "-legacy") in
  write (legacy root)
    (json
       (`Assoc
          [
            ("v", `Int 1);
            ( "accounts",
              `List
                [
                  `Assoc
                    [
                      ("id", s id);
                      ("label", s "Legacy");
                      ("claude_config_dir", s folder);
                    ];
                ] );
          ]));
  folder

let find t backend id = R.find t { R.backend; id }
let env t backend id = R.launch_env (ok (find t backend id))

let test_legacy_bytes root =
  let folder = declare_legacy root "old" in
  (* Native custody rules must not change a legacy-only installation. *)
  Unix.chmod root 0o755;
  let t = ok (load root) in
  let expected =
    Printf.sprintf
      {|{"accounts":[{"id":"old","label":"Legacy","claude_config_dir":"%s"}]}|}
      folder
  in
  Alcotest.(check string) "legacy bytes" expected (json (R.to_host_json t));
  ignore (ok (R.prepare_id ~uid t "old"));
  Alcotest.(check bool)
    "legacy prepare still creates" true (Sys.is_directory folder)

let test_source_preference root =
  let old = declare_legacy root "old" in
  let current = native_profile root "claude" "work" "Current" "current" in
  registry root [ current ];
  write (legacy root) "malformed legacy must not be read";
  let t = ok (load root) in
  Alcotest.(check (list (pair string string)))
    "native root"
    [ ("CLAUDE_CONFIG_DIR", path root "current") ]
    (env t R.Claude "work");
  refuses "account_unknown" (find t R.Claude "old");
  ignore (ok (R.prepare_id ~uid t "work"));
  Alcotest.(check bool) "legacy root not prepared" false (Sys.file_exists old);
  Unix.unlink (legacy root);
  ignore (ok (load root));
  registry root [];
  let empty = ok (load root) in
  Alcotest.(check int)
    "configured empty means no aliases" 0
    (List.length (R.list empty));
  ignore (ok (find empty R.Codex "default"));
  refuses "account_unknown" (R.resolve_name empty R.Claude "unknown")

let test_configured_refusals root =
  ignore (declare_legacy root "old");
  let check () =
    refuses "accounts_refused" (load root);
    match R.resolve ~uid ~file:(legacy root) R.Claude "default" with
    | Ok _ -> Alcotest.fail "malformed source fell back to synthetic default"
    | Error (error, candidates) ->
        Alcotest.(check string)
          "resolve fails closed" "accounts_refused" error.code;
        Alcotest.(check int) "no candidates" 0 (List.length candidates)
  in
  write (native root) "{";
  check ();
  Unix.unlink (native root);
  Unix.symlink (path root "absent") (native root);
  check ();
  Unix.unlink (native root);
  Unix.symlink (legacy root) (native root);
  check ();
  Unix.unlink (native root);
  Unix.mkdir (native root) 0o700;
  check ();
  Unix.rmdir (native root);
  registry root [];
  Unix.chmod (native root) 0o644;
  check ();
  Unix.chmod (native root) 0o600;
  Unix.link (native root) (path root "second-name");
  check ();
  Unix.unlink (path root "second-name");
  Unix.chmod root 0o755;
  check ()

let test_metadata_validation root =
  ignore (declare_legacy root "old");
  let roots =
    [ ("config", path root "config"); ("history", path root "history") ]
  in
  let p = profile "claude" "work" "Work" roots in
  List.iter
    (fun profiles ->
      registry root profiles;
      refuses "accounts_refused" (load root))
    [
      [ p; p ];
      [ profile "claude" "default" "Work" roots ];
      [ profile "claude" "work" "Bad\nlabel" roots ];
      [ profile "claude" "work" "Work" [ ("config", path root "config") ] ];
      [
        profile "claude" "work" "Work"
          [ ("config", path root "config"); ("history", path root "config") ];
      ];
      [
        p;
        profile ~enabled:false "claude" "other" "WORK"
          [
            ("config", path root "other"); ("history", path root "other-history");
          ];
      ];
    ]

let test_backend_identity root =
  let codex = native_profile root "codex" "work" "Codex Work" "codex" in
  let claude = native_profile root "claude" "work" "Claude Work" "claude" in
  registry root [ codex; claude ];
  let t = ok (load root) in
  Alcotest.(check (list string))
    "independent labels in authored order"
    [ "Codex Work"; "Claude Work" ]
    (List.map R.label (R.list t));
  Alcotest.(check string)
    "Claude lookup" "Claude Work"
    (R.label (ok (R.resolve_name t R.Claude "CLAUDE WORK")));
  Alcotest.(check string)
    "Codex lookup" "Codex Work"
    (R.label (ok (R.resolve_name t R.Codex "codex work")));
  refuses "account_unknown" (R.resolve_name t R.Codex "Claude Work");
  Alcotest.(check (list (pair string string)))
    "Codex native selector"
    [ ("CODEX_HOME", path root "codex") ]
    (env t R.Codex "work");
  let account =
    `Assoc
      [
        ("id", s "work");
        ("label", s "Codex Work");
        ("claude_config_dir", s (path root "claude"));
        ("codex_home", s (path root "codex"));
        ( "backend_labels",
          `Assoc [ ("codex", s "Codex Work"); ("claude", s "Claude Work") ] );
      ]
  in
  let expected =
    `Assoc
      [
        ("accounts", `List [ account ]);
        ( "protected_roots",
          `List [ s (path root "codex"); s (path root "claude") ] );
      ]
  in
  Alcotest.(check string)
    "exact native host shape" (json expected)
    (json (R.to_host_json t));
  Alcotest.(check string)
    "native prepare shape" (json account)
    (json (ok (R.prepare_id ~uid t "work")));
  Alcotest.(check string)
    "backend-specific badge"
    {|{"id":"work","label":"Claude Work","declared":true}|}
    (json (R.describe_current t R.Claude (Some "work")))

let test_disabled_and_unqualified root =
  let enabled = native_profile root "claude" "work" "On" "enabled" in
  let disabled =
    profile ~enabled:false "codex" "work" "Off"
      [
        ("config", path root "disabled");
        ("state", path root "disabled/sessions");
      ]
  in
  let pi = native_profile ~enabled:false root "pi" "pi" "Pi" "pi" in
  let opencode =
    profile ~enabled:false "opencode-v2" "oc" "OpenCode"
      (List.map
         (fun role -> (role, path root ("oc-" ^ role)))
         [ "config"; "data"; "state"; "cache" ])
  in
  let pi_on = native_profile root "pi" "pi-on" "Pi enabled" "pi-on" in
  let oc_on =
    profile "opencode-v2" "oc-on" "OpenCode enabled"
      (List.map
         (fun role -> (role, path root ("oc-on-" ^ role)))
         [ "config"; "data"; "state"; "cache" ])
  in
  registry root [ enabled; disabled; pi; opencode; pi_on; oc_on ];
  let t = ok (load root) in
  Alcotest.(check int)
    "only enabled qualified backend offered" 1
    (List.length (R.list t));
  refuses "account_no_agent" (find t R.Codex "work");
  refuses "account_unknown" (find t R.Claude "pi-on");
  refuses "account_unknown" (find t R.Claude "oc");
  refuses "account_unknown" (find t R.Codex "oc-on");
  refuses "account_unknown" (R.prepare_id ~uid t "pi");
  ignore (ok (R.prepare_id ~uid t "work"));
  List.iter
    (fun name ->
      Alcotest.(check bool)
        (name ^ " not created") false
        (Sys.file_exists (path root name)))
    [ "disabled"; "oc-config"; "oc-data"; "oc-state"; "oc-cache" ];
  Alcotest.(check (list string))
    "all credential roles, including disabled"
    (List.map (path root)
       [
         "enabled";
         "disabled";
         "pi";
         "oc-config";
         "oc-data";
         "oc-state";
         "pi-on";
         "oc-on-config";
         "oc-on-data";
         "oc-on-state";
       ])
    (R.protected_roots t);
  Alcotest.(check bool)
    "Pi not a launch backend" true
    (R.backend_of_string "pi" = None);
  Alcotest.(check bool)
    "OpenCode not a launch backend" true
    (R.backend_of_string "opencode-v2" = None)

let test_native_name_ambiguity root =
  registry root
    [
      native_profile root "claude" "alpha" "  Beta  " "alpha";
      native_profile root "claude" "beta" "Other" "beta";
      native_profile root "codex" "beta" "Beta" "codex";
    ];
  let t = ok (load root) in
  refuses "account_ambiguous" (R.resolve_name t R.Claude "beta");
  Alcotest.(check string)
    "trimmed label" "Beta"
    (R.label (ok (find t R.Claude "alpha")));
  Alcotest.(check string)
    "case does not silently choose an exact id" "alpha"
    (R.ref_ (ok (R.resolve_name t R.Claude "BETA"))).id;
  Alcotest.(check string)
    "other backend unaffected" "beta"
    (R.ref_ (ok (R.resolve_name t R.Codex "beta"))).id

let test_conversation_subtrees root =
  let a = mkdir root "a" and b = mkdir root "b" in
  let shared = mkdir a "projects" in
  registry root
    [
      profile "claude" "a" "A" [ ("config", a); ("history", shared) ];
      profile "claude" "b" "B" [ ("config", b); ("history", shared) ];
    ];
  let t = ok (load root) in
  Alcotest.(check (list string))
    "history is not a separate credential root" [ a; b ] (R.protected_roots t);
  let secret = Filename.concat a ".credentials.json" in
  write secret "not JSON and not a conversation";
  Unix.chmod secret 0o000;
  ignore (ok (load root));
  ignore (ok (R.prepare_id ~uid t "b"));
  Alcotest.(check int)
    "credential mode unchanged" 0
    ((Unix.lstat secret).Unix.st_perm land 0o777)

let test_prepare_and_late_custody root =
  let config = path root "fresh" in
  registry root
    [
      profile "claude" "work" "Work"
        [ ("config", config); ("history", Filename.concat config "projects") ];
    ];
  let t = ok (load root) in
  Alcotest.(check bool)
    "list did not create roots" false (Sys.file_exists config);
  let entry = ok (find t R.Claude "work") in
  Alcotest.(check string)
    "carry creates only its rollback-capable root" config
    (ok (R.carry_folder ~uid ~getenv:(fun _ -> None) ~create:true entry));
  Alcotest.(check (list string))
    "no eager carry subdirectories" []
    (Array.to_list (Sys.readdir config));
  ignore (ok (R.prepare ~uid entry));
  List.iter
    (fun folder ->
      Alcotest.(check int)
        "created private" 0o700
        ((Unix.lstat folder).Unix.st_perm land 0o777))
    [ config; Filename.concat config "projects" ];
  Unix.chmod config 0o777;
  refuses "account_folder_refused" (R.prepare ~uid entry);
  refuses "account_folder_refused"
    (R.carry_folder ~uid ~getenv:(fun _ -> None) ~create:false entry);
  Unix.chmod config 0o700;
  Unix.rename config (path root "moved");
  Unix.symlink (path root "moved") config;
  refuses "account_folder_refused" (R.prepare ~uid entry);
  refuses "accounts_refused" (load root)

let test_fresh_commands root =
  let p = native_profile root "claude" "work" "Work" "current" in
  registry root [ p ];
  let pinned = ok (find (ok (load root)) R.Claude "work") in
  let old = declare_legacy root "work" in
  ignore (ok (R.prepare ~uid pinned));
  Alcotest.(check bool)
    "prepare never re-reads a legacy value" false (Sys.file_exists old);
  registry root
    [
      profile ~enabled:false "claude" "work" "Work"
        [
          ("config", path root "current");
          ("history", path root "current/projects");
        ];
    ];
  let fresh = ok (load root) in
  refuses "account_unknown" (find fresh R.Claude "work");
  refuses "account_unknown" (R.prepare_id ~uid fresh "work")

let test_retired_legacy root =
  ignore (declare_legacy root "old");
  let current = native_profile root "claude" "work" "Current" "current" in
  registry root [ current ];
  let marker = path root "backend-profiles.migrated" in
  write marker "{\"version\":1}";
  ignore (ok (load root));
  Unix.unlink (native root);
  refuses "accounts_refused" (load root);
  Unix.unlink marker;
  Unix.symlink (path root "missing") marker;
  refuses "accounts_refused" (load root);
  Unix.unlink marker;
  (* A deliberate operator rollback removes the retirement fence, not just the registry. *)
  ignore (ok (find (ok (load root)) R.Claude "old"))

let () =
  Alcotest.run "native account source convergence"
    [
      ( "registry",
        List.map
          (fun (name, test) -> Alcotest.test_case name `Quick (with_root test))
          [
            ("legacy bytes", test_legacy_bytes);
            ("native source preference", test_source_preference);
            ("configured refusals never fall back", test_configured_refusals);
            ( "retired legacy cannot revive when registry disappears",
              test_retired_legacy );
            ("native metadata validation", test_metadata_validation);
            ("backend-qualified identities and host JSON", test_backend_identity);
            ("disabled and unqualified profiles", test_disabled_and_unqualified);
            ( "native name ambiguity stays backend-qualified",
              test_native_name_ambiguity );
            ( "shared conversation subtrees, no credential read",
              test_conversation_subtrees );
            ("prepare and late custody", test_prepare_and_late_custody);
            ("fresh commands and pinned roots", test_fresh_commands);
          ] );
    ]
