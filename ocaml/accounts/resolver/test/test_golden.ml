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

let temporary () =
  let base =
    Filename.concat (Filename.get_temp_dir_name ()) "mesh-resolver-golden"
  in
  (try Unix.mkdir base 0o700 with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
  Unix.realpath (Filename.temp_dir ~temp_dir:base ~perms:0o700 "t" "")

let write_file path text =
  Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_trunc ] 0o600 path
    (fun channel -> output_string channel text)

(* A root holding accounts.json with two aliases: work (both folders, the
   Claude one present, the Codex one missing) and travel (Codex only). *)
let fixture () =
  let root = temporary () in
  Unix.mkdir (Filename.concat root "work") 0o700;
  Unix.mkdir (Filename.concat root "work/claude") 0o700;
  let file = Filename.concat root "accounts.json" in
  write_file file
    (Printf.sprintf
       {|{"v": 1, "accounts": [
  {"id": "work", "label": "Work", "claude_config_dir": "%s/work/claude", "codex_home": "%s/work/codex"},
  {"id": "travel", "label": "Travel", "codex_home": "%s/travel-codex"}]}|}
       root root root);
  (root, file)

let expect name (code, out, err) (code', out', err') =
  Alcotest.(check int) (name ^ ": exit code") code code';
  Alcotest.(check string) (name ^ ": stdout") out out';
  Alcotest.(check string) (name ^ ": stderr") err err'

let is_private_directory path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; st_perm; _ } -> st_perm land 0o777 = 0o700
  | _ | (exception Unix.Unix_error _) -> false

let test_list () =
  let root, file = fixture () in
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

let test_list_refused () =
  let root = temporary () in
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

let test_prepare () =
  let root, file = fixture () in
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

let test_prepare_refused () =
  let _root, file = fixture () in
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

let test_resolve () =
  let root, file = fixture () in
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
  let code, _, _ = resolve "pi" "work" in
  Alcotest.(check int) "unknown backend: usage" 2 code

let test_resolve_ambiguous () =
  let root = temporary () in
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

let () =
  Alcotest.run "mesh-platform accounts (golden)"
    [
      ( "golden",
        [
          Alcotest.test_case "list" `Quick test_list;
          Alcotest.test_case "list refused" `Quick test_list_refused;
          Alcotest.test_case "prepare" `Quick test_prepare;
          Alcotest.test_case "prepare refused" `Quick test_prepare_refused;
        ] );
      ( "resolve",
        [
          Alcotest.test_case "resolve" `Quick test_resolve;
          Alcotest.test_case "ambiguous" `Quick test_resolve_ambiguous;
        ] );
    ]
