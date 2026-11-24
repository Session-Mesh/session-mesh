(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The exact bytes, exit code and side effects of [mesh-platform accounts list]
   and [accounts prepare], which the web server parses: written against the
   program before these commands went through Mesh_account_resolver, and kept
   unchanged since. Then [accounts resolve]. *)

let exe = "../../../platform/cli/mesh_platform_main.exe"

let read_all descriptor =
  In_channel.input_all (Unix.in_channel_of_descr descriptor)

let run arguments =
  let out_read, out_write = Unix.pipe ~cloexec:true () in
  let err_read, err_write = Unix.pipe ~cloexec:true () in
  let child =
    Unix.create_process exe
      (Array.of_list ("mesh-platform" :: arguments))
      Unix.stdin out_write err_write
  in
  Unix.close out_write;
  Unix.close err_write;
  let stdout_text = read_all out_read in
  let stderr_text = read_all err_read in
  let _, status = Unix.waitpid [] child in
  let code = match status with Unix.WEXITED code -> code | _ -> -1 in
  (code, stdout_text, stderr_text)

(* Each test gets its own private folder under TMPDIR, removed with all it
   holds when the test ends, whatever the outcome; a symbolic link is removed,
   never followed. *)
let rec remove_tree path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Unix.chmod path 0o700;
      Array.iter
        (fun name -> remove_tree (Filename.concat path name))
        (Sys.readdir path);
      Unix.rmdir path
  | _ -> Sys.remove path
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let with_temporary test () =
  let root =
    Unix.realpath (Filename.temp_dir ~perms:0o700 "mesh-resolver-golden" "")
  in
  Fun.protect ~finally:(fun () -> remove_tree root) (fun () -> test root)

let write_file path text =
  Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_trunc ] 0o600 path
    (fun channel -> output_string channel text)

(* A root holding accounts.json with two aliases: work (both folders, the
   Claude one present, the Codex one missing) and travel (Codex only). *)
let fixture root =
  Unix.mkdir (Filename.concat root "work") 0o700;
  Unix.mkdir (Filename.concat root "work/claude") 0o700;
  let file = Filename.concat root "accounts.json" in
  write_file file
    (Printf.sprintf
       {|{"v": 1, "accounts": [
  {"id": "work", "label": "Work", "claude_config_dir": "%s/work/claude", "codex_home": "%s/work/codex"},
  {"id": "travel", "label": "Travel", "codex_home": "%s/travel-codex"}]}|}
       root root root);
  file

let expect name (code, out, err) (code', out', err') =
  Alcotest.(check int) (name ^ ": exit code") code code';
  Alcotest.(check string) (name ^ ": stdout") out out';
  Alcotest.(check string) (name ^ ": stderr") err err'

let is_private_directory path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; st_perm; _ } -> st_perm land 0o777 = 0o700
  | _ | (exception Unix.Unix_error _) -> false

let test_list root =
  let file = fixture root in
  expect "list"
    ( 0,
      Printf.sprintf
        {|{"accounts":[{"id":"work","label":"Work","claude_config_dir":"%s/work/claude","codex_home":"%s/work/codex"},{"id":"travel","label":"Travel","codex_home":"%s/travel-codex"}]}|}
        root root root
      ^ "\n",
      "" )
    (run [ "accounts"; "list"; file ]);
  Alcotest.(check bool)
    "list creates nothing" false
    (Sys.file_exists (Filename.concat root "work/codex"))

let test_list_refused root =
  let file = Filename.concat root "accounts.json" in
  write_file file "{";
  expect "not JSON"
    ( 1,
      {|{"kind":"accounts","error":"accounts.json is not JSON"}|} ^ "\n",
      "mesh-platform: accounts.json is not JSON\n" )
    (run [ "accounts"; "list"; file ]);
  write_file file
    (Printf.sprintf
       {|{"v": 1, "accounts": [{"id": "work", "label": "Work", "claude_config_dir": "%s/none/claude"}]}|}
       root);
  let message = Printf.sprintf "work: %s/none does not exist" root in
  expect "missing parent"
    ( 1,
      Printf.sprintf {|{"kind":"accounts","error":"%s"}|} message ^ "\n",
      "mesh-platform: " ^ message ^ "\n" )
    (run [ "accounts"; "list"; file ]);
  write_file file
    {|{"v": 1, "accounts": [{"id": "default", "label": "D", "codex_home": "/x"}]}|};
  let message = "an account id must match [a-z0-9-]{1,32} and not be default" in
  expect "default in the file"
    ( 1,
      Printf.sprintf {|{"kind":"accounts","error":"%s"}|} message ^ "\n",
      "mesh-platform: " ^ message ^ "\n" )
    (run [ "accounts"; "list"; file ])

let test_prepare root =
  let file = fixture root in
  expect "prepare work"
    ( 0,
      Printf.sprintf
        {|{"account":{"id":"work","label":"Work","claude_config_dir":"%s/work/claude","codex_home":"%s/work/codex"}}|}
        root root
      ^ "\n",
      "" )
    (run [ "accounts"; "prepare"; file; "work" ]);
  Alcotest.(check bool)
    "the missing Codex folder is created 0700" true
    (is_private_directory (Filename.concat root "work/codex"));
  expect "prepare travel"
    ( 0,
      Printf.sprintf
        {|{"account":{"id":"travel","label":"Travel","codex_home":"%s/travel-codex"}}|}
        root
      ^ "\n",
      "" )
    (run [ "accounts"; "prepare"; file; "travel" ]);
  Alcotest.(check bool)
    "travel's folder is created 0700" true
    (is_private_directory (Filename.concat root "travel-codex"))

let unknown =
  ( 1,
    {|{"kind":"accounts","error":"unknown account"}|} ^ "\n",
    "mesh-platform: unknown account\n" )

let test_prepare_refused root =
  let file = fixture root in
  expect "unknown" unknown (run [ "accounts"; "prepare"; file; "nobody" ]);
  expect "default is not in the file" unknown
    (run [ "accounts"; "prepare"; file; "default" ]);
  expect "a label is not an id" unknown
    (run [ "accounts"; "prepare"; file; "Work" ]);
  expect "a prefix is not an id" unknown
    (run [ "accounts"; "prepare"; file; "wor" ])

(* [accounts resolve FILE BACKEND NAME]: written with the command. *)
let resolved backend id label =
  ( 0,
    Printf.sprintf {|{"account":{"backend":"%s","id":"%s","label":"%s"}}|}
      backend id label
    ^ "\n",
    "" )

let resolve_refused code message =
  ( 1,
    Printf.sprintf {|{"kind":"accounts","error":"%s","code":"%s"}|} message code
    ^ "\n",
    "mesh-platform: " ^ message ^ "\n" )

let test_resolve root =
  let file = fixture root in
  let resolve backend name = run [ "accounts"; "resolve"; file; backend; name ] in
  expect "exact id" (resolved "claude" "work" "Work") (resolve "claude" "work");
  expect "label, any case" (resolved "codex" "travel" "Travel")
    (resolve "codex" "TRAVEL");
  expect "another backend's account"
    (resolve_refused "account_no_agent" "account travel has no Claude folder")
    (resolve "claude" "travel");
  expect "prefix"
    (resolve_refused "account_unknown" "unknown account")
    (resolve "codex" "trav");
  expect "default"
    (resolved "codex" "default" "Default account")
    (resolve "codex" "default");
  Alcotest.(check bool)
    "resolve creates nothing" false
    (Sys.file_exists (Filename.concat root "work/codex"));
  let code, _, _ = resolve "vibe" "work" in
  Alcotest.(check int) "unknown backend: usage" 2 code

let test_resolve_ambiguous root =
  let file = Filename.concat root "accounts.json" in
  write_file file
    (Printf.sprintf
       {|{"v": 1, "accounts": [{"id": "spare", "label": "DEFAULT ACCOUNT", "claude_config_dir": "%s/spare"}]}|}
       root);
  let message =
    "several accounts match: default (Default account), spare (DEFAULT ACCOUNT)"
  in
  expect "ambiguous"
    ( 1,
      Printf.sprintf
        {|{"kind":"accounts","error":"%s","code":"account_ambiguous","candidates":[{"backend":"claude","id":"default","label":"Default account"},{"backend":"claude","id":"spare","label":"DEFAULT ACCOUNT"}]}|}
        message
      ^ "\n",
      "mesh-platform: " ^ message ^ "\n" )
    (run [ "accounts"; "resolve"; file; "claude"; "default account" ]);
  expect "one candidate in the other backend"
    (resolved "codex" "default" "Default account")
    (run [ "accounts"; "resolve"; file; "codex"; "default account" ])

(* One alias's label is the other's id: the exact id no longer wins on its own,
   so the letter case cannot pick the account. *)
let test_resolve_id_and_label root =
  let file = Filename.concat root "accounts.json" in
  write_file file
    (Printf.sprintf
       {|{"v": 1, "accounts": [{"id": "x", "label": "y", "claude_config_dir": "%s/x"}, {"id": "y", "label": "Other", "claude_config_dir": "%s/y"}]}|}
       root root);
  let message = "several accounts match: y (Other), x (y)" in
  expect "id of one, label of the other"
    ( 1,
      Printf.sprintf
        {|{"kind":"accounts","error":"%s","code":"account_ambiguous","candidates":[{"backend":"claude","id":"y","label":"Other"},{"backend":"claude","id":"x","label":"y"}]}|}
        message
      ^ "\n",
      "mesh-platform: " ^ message ^ "\n" )
    (run [ "accounts"; "resolve"; file; "claude"; "y" ]);
  expect "a label only" (resolved "claude" "x" "y")
    (run [ "accounts"; "resolve"; file; "claude"; "Y" ])

(* A refusal of the file names no folder in [resolve], even one of another
   alias; [list] keeps printing it, byte for byte. *)
let test_resolve_sanitized root =
  let file = Filename.concat root "accounts.json" in
  Unix.mkdir (Filename.concat root "a") 0o700;
  write_file file
    (Printf.sprintf
       {|{"v": 1, "accounts": [{"id": "a", "label": "A", "claude_config_dir": "%s/a"}, {"id": "b", "label": "B", "codex_home": "%s/none/b"}]}|}
       root root);
  expect "resolve: no path"
    (resolve_refused "accounts_refused" "b: <path> does not exist")
    (run [ "accounts"; "resolve"; file; "claude"; "a" ]);
  let raw = Printf.sprintf "b: %s/none does not exist" root in
  expect "list: unchanged"
    ( 1,
      Printf.sprintf {|{"kind":"accounts","error":"%s"}|} raw ^ "\n",
      "mesh-platform: " ^ raw ^ "\n" )
    (run [ "accounts"; "list"; file ])

(* Native registry commands keep the old FILE argument, but share one source
   preference and preserve independent backend labels under a grouped id. *)
let test_native_commands root =
  let file = Filename.concat root "accounts.json" in
  let registry = Filename.concat root "backend-profiles.json" in
  write_file file "invalid legacy source must not be read";
  let declare codex_enabled =
    write_file registry
      (Printf.sprintf
         {|{"version":1,"profiles":[{"id":"work","label":"Claude Work","backend":"claude","enabled":true,"roots":{"config":"%s/claude","history":"%s/claude/projects"}},{"id":"work","label":"Codex Work","backend":"codex","enabled":%b,"roots":{"config":"%s/codex","state":"%s/codex/sessions"}}]}|}
         root root codex_enabled root root)
  in
  declare true;
  expect "native list"
    ( 0,
      Printf.sprintf
        {|{"accounts":[{"id":"work","label":"Claude Work","claude_config_dir":"%s/claude","codex_home":"%s/codex","backend_labels":{"claude":"Claude Work","codex":"Codex Work"}}],"protected_roots":["%s/claude","%s/codex"],"launch_profiles":[{"backend":"claude","id":"work","label":"Claude Work"},{"backend":"codex","id":"work","label":"Codex Work"}]}|}
        root root root root
      ^ "\n",
      "" )
    (run [ "accounts"; "list"; file ]);
  expect "native Claude label" (resolved "claude" "work" "Claude Work")
    (run [ "accounts"; "resolve"; file; "claude"; "CLAUDE WORK" ]);
  expect "native Codex label" (resolved "codex" "work" "Codex Work")
    (run [ "accounts"; "resolve"; file; "codex"; "CODEX WORK" ]);
  declare false;
  expect "native prepare enabled roots only"
    ( 0,
      Printf.sprintf
        {|{"account":{"id":"work","label":"Claude Work","claude_config_dir":"%s/claude","backend_labels":{"claude":"Claude Work"}}}|}
        root
      ^ "\n",
      "" )
    (run [ "accounts"; "prepare"; file; "work" ]);
  Alcotest.(check bool) "native history prepared" true
    (is_private_directory (Filename.concat root "claude/projects"));
  Alcotest.(check bool) "disabled native root not created" false
    (Sys.file_exists (Filename.concat root "codex"));
  expect "disabled backend refuses"
    (resolve_refused "account_no_agent" "account work has no Codex folder")
    (run [ "accounts"; "resolve"; file; "codex"; "work" ]);
  write_file registry "{";
  expect "configured malformed never resolves even default"
    (resolve_refused "accounts_refused"
       "backend-profiles.json: invalid-profile-config")
    (run [ "accounts"; "resolve"; file; "claude"; "default" ])

let () =
  Alcotest.run "mesh-platform accounts (golden)"
    [
      ( "golden",
        [
          Alcotest.test_case "list" `Quick (with_temporary test_list);
          Alcotest.test_case "list refused" `Quick
            (with_temporary test_list_refused);
          Alcotest.test_case "prepare" `Quick (with_temporary test_prepare);
          Alcotest.test_case "prepare refused" `Quick
            (with_temporary test_prepare_refused);
        ] );
      ( "resolve",
        [
          Alcotest.test_case "resolve" `Quick (with_temporary test_resolve);
          Alcotest.test_case "ambiguous" `Quick
            (with_temporary test_resolve_ambiguous);
          Alcotest.test_case "id and label" `Quick
            (with_temporary test_resolve_id_and_label);
          Alcotest.test_case "sanitized" `Quick
            (with_temporary test_resolve_sanitized);
        ] );
      ( "native registry",
        [ Alcotest.test_case "shared CLI source" `Quick (with_temporary test_native_commands) ] );
    ]
