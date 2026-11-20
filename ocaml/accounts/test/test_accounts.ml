(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The operator's account aliases: the file's structure, the path rule that
   keeps a folder safe on a shell command line, and the folder checks. *)

module A = Mesh_accounts

let uid = Unix.geteuid ()

let parsed text =
  match A.parse text with
  | Ok accounts -> accounts
  | Error message -> Alcotest.fail message

let refused text =
  match A.parse text with
  | Ok _ -> Alcotest.failf "accepted: %s" text
  | Error _ -> ()

let one fields = Printf.sprintf {|{"v": 1, "accounts": [{%s}]}|} fields

let test_valid () =
  match
    parsed
      (one
         {|"id": "work", "label": "Atacama", "claude_config_dir": "/home/u/.acc/work/.claude", "codex_home": "/home/u/.acc/work/.codex"|})
  with
  | [
   {
     A.id = "work";
     label = "Atacama";
     claude_config_dir = Some "/home/u/.acc/work/.claude";
     codex_home = Some "/home/u/.acc/work/.codex";
   };
  ] ->
      ()
  | _ -> Alcotest.fail "unexpected account"

let test_one_member () =
  match
    parsed
      (one
         {|"id": "perso", "label": "Perso", "codex_home": "/home/u/.codex-perso"|})
  with
  | [ { A.claude_config_dir = None; codex_home = Some _; _ } ] -> ()
  | _ -> Alcotest.fail "unexpected account"

let test_refused_structure () =
  List.iter refused
    [
      {|[]|};
      {|{"v": 2, "accounts": []}|};
      {|{"v": 1, "accounts": [], "extra": 1}|};
      one {|"id": "work", "label": "Work"|};
      one
        {|"id": "work", "label": "Work", "codex_home": "/a/b", "env": {"LD_PRELOAD": "/x"}|};
      one
        {|"id": "work", "label": "Work", "codex_home": "/a/b", "codex_home": "/a/c"|};
      {|{"v": 1, "accounts": [{"id": "a", "label": "A", "codex_home": "/a/b"}, {"id": "a", "label": "B", "codex_home": "/a/c"}]}|};
      {|{"v": 1, "accounts": [{"id": "a", "label": "A", "codex_home": "/a/b"}, {"id": "b", "label": "B", "claude_config_dir": "/a/b"}]}|};
    ]

let test_ids () =
  List.iter
    (fun id -> Alcotest.(check bool) id true (A.valid_id id))
    [ "a"; "work"; "pro-2"; String.make 32 'x' ];
  List.iter
    (fun id -> Alcotest.(check bool) id false (A.valid_id id))
    [ ""; "default"; "Work"; "a_b"; "a b"; "../x"; String.make 33 'x'; "é" ]

let test_labels () =
  List.iter
    (fun label -> Alcotest.(check bool) label true (A.valid_label label))
    [ "Atacama"; "Perso"; "Société Générale"; String.make 24 'x' ];
  List.iter
    (fun label ->
      Alcotest.(check bool) (String.escaped label) false (A.valid_label label))
    [
      ""; "   "; String.make 25 'x'; "a\nb"; "a\x1bb"; "a\xe2\x80\xaeb"; "\xff";
    ]

let test_paths () =
  List.iter
    (fun path -> Alcotest.(check bool) path true (A.valid_path path))
    [ "/home/u/.claude-pro"; "/home/u/.acc/work/.codex"; "/a" ];
  List.iter
    (fun path -> Alcotest.(check bool) path false (A.valid_path path))
    [
      "";
      "/";
      "relative/x";
      "~/x";
      "/a/";
      "/a//b";
      "/a/./b";
      "/a/../b";
      "/a b";
      "/a;rm";
      "/a$(x)";
      "/a'b";
      "/a\"b";
      "/a`b";
      "/a\\b";
      "/a\nb";
      "/a*";
      "/" ^ String.make 1024 'a';
    ]

let temporary () =
  let base =
    Filename.concat (Filename.get_temp_dir_name ()) "mesh-accounts-test"
  in
  (try Unix.mkdir base 0o700 with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
  let dir = Filename.temp_dir ~temp_dir:base ~perms:0o700 "t" "" in
  Unix.realpath dir

let ok what = function
  | Ok () -> ()
  | Error message -> Alcotest.failf "%s: %s" what message

let error what = function
  | Ok () -> Alcotest.failf "%s accepted" what
  | Error _ -> ()

let test_directories () =
  let root = temporary () in
  let existing = Filename.concat root "claude" in
  Unix.mkdir existing 0o755;
  ok "existing" (A.check_directory ~uid existing);
  let missing = Filename.concat root "codex" in
  ok "missing, creatable" (A.check_directory ~uid missing);
  error "missing parent"
    (A.check_directory ~uid (Filename.concat root "no/codex"));
  let open_dir = Filename.concat root "open" in
  Unix.mkdir open_dir 0o777;
  Unix.chmod open_dir 0o777;
  error "writable by others" (A.check_directory ~uid open_dir);
  error "parent writable by others"
    (A.check_directory ~uid (Filename.concat open_dir "x"));
  let file = Filename.concat root "file" in
  Out_channel.with_open_bin file ignore;
  error "a file" (A.check_directory ~uid file);
  error "another owner" (A.check_directory ~uid:(uid + 1) existing)

let test_links () =
  let root = temporary () in
  let real = Filename.concat root "real" in
  Unix.mkdir real 0o700;
  let link = Filename.concat root "link" in
  Unix.symlink real link;
  error "the folder is a link" (A.check_directory ~uid link);
  error "a component is a link"
    (A.check_directory ~uid (Filename.concat link "inner"));
  Unix.mkdir (Filename.concat real "sub") 0o700;
  error "an upper component is a link (the folder exists behind it)"
    (A.check_directory ~uid (Filename.concat link "sub"));
  error "a missing folder whose parent lies behind a link"
    (A.check_directory ~uid (Filename.concat link "sub/inner"));
  error "prepare through a link"
    (A.prepare_directory ~uid (Filename.concat link "inner"));
  Alcotest.(check bool)
    "nothing created through the link" false
    (Sys.file_exists (Filename.concat real "inner"))

let test_prepare () =
  let root = temporary () in
  let folder = Filename.concat root "codex" in
  ok "prepare" (A.prepare_directory ~uid folder);
  Alcotest.(check int) "mode 0700" 0o700 (Unix.stat folder).st_perm;
  ok "prepare again" (A.prepare_directory ~uid folder)

let write path text =
  Out_channel.with_open_bin path (fun channel -> output_string channel text)

let test_load () =
  let root = temporary () in
  let file = Filename.concat root "accounts.json" in
  let claude = Filename.concat root "claude" in
  write file
    (one
       (Printf.sprintf
          {|"id": "work", "label": "Work", "claude_config_dir": "%s"|} claude));
  (match A.load ~uid file with
  | Ok [ { A.id = "work"; _ } ] -> ()
  | Ok _ -> Alcotest.fail "unexpected accounts"
  | Error message -> Alcotest.fail message);
  Alcotest.(check bool) "load creates nothing" false (Sys.file_exists claude);
  let link = Filename.concat root "accounts-link.json" in
  Unix.symlink file link;
  (match A.load ~uid link with
  | Ok _ -> Alcotest.fail "a linked file was read"
  | Error _ -> ());
  write file
    (one
       {|"id": "work", "label": "Work", "claude_config_dir": "/nonexistent-parent/x/.claude"|});
  match A.load ~uid file with
  | Ok _ -> Alcotest.fail "a folder without parent was accepted"
  | Error _ -> ()

let () =
  Alcotest.run "mesh_accounts"
    [
      ( "parse",
        [
          Alcotest.test_case "a full alias" `Quick test_valid;
          Alcotest.test_case "one member" `Quick test_one_member;
          Alcotest.test_case "refused structures" `Quick test_refused_structure;
          Alcotest.test_case "ids" `Quick test_ids;
          Alcotest.test_case "labels" `Quick test_labels;
          Alcotest.test_case "paths" `Quick test_paths;
        ] );
      ( "folders",
        [
          Alcotest.test_case "checks" `Quick test_directories;
          Alcotest.test_case "links" `Quick test_links;
          Alcotest.test_case "prepare" `Quick test_prepare;
          Alcotest.test_case "load" `Quick test_load;
        ] );
    ]
