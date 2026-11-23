(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)
open Work_read_runner
module U = Yojson.Safe.Util

let register repo =
  let git = Filename.concat repo.wl_home ".git" in
  Unix.mkdir git 0o700;
  let root = Unix.stat repo.wl_home and gitstat = Unix.stat git in
  let file = Filename.concat repo.home "instance.json" in
  let s x = `String (string_of_int x) in
  let value =
    `Assoc
      [
        ("version", `Int 1);
        ("instance_id", `String (String.make 64 'a'));
        ("root_dev", s root.st_dev);
        ("root_ino", s root.st_ino);
        ("git_dev", s gitstat.st_dev);
        ("git_ino", s gitstat.st_ino);
      ]
  in
  write_file file (Yojson.Safe.to_string value);
  Unix.chmod file 0o600;
  file

let resolve ?(project = "P-5e6f") ?(product = "relay") repo file =
  run
    ~env:[ ("MESH_WORK_INSTANCE_REGISTRATION", file) ]
    repo
    [ "attachment-context"; "--project"; project; "--product"; product ]

let canonical () =
  let repo = copy_fixture () in
  let registration = register repo in
  let before = tree_state repo.wl_home in
  let reply = resolve repo registration in
  Alcotest.(check int) "accepted" 0 reply.code;
  let doc = json reply in
  Alcotest.(check string)
    "canonical" "P-5e6f"
    U.(to_string (member "project_id" doc));
  Alcotest.(check string)
    "product" "relay"
    U.(to_string (member "product_id" doc));
  Alcotest.(check string)
    "operator identity" (String.make 64 'a')
    U.(to_string (member "instance_id" doc));
  Alcotest.(check bool)
    "no tracker writes" true
    (before = tree_state repo.wl_home);
  Alcotest.(check bool)
    "no path in output" false
    (String.contains reply.out '/')

let absent () =
  let repo = copy_fixture () in
  Alcotest.(check bool)
    "unregistered refuses" true
    ((resolve repo "/nonexistent").code <> 0)

let exact () =
  let repo = copy_fixture () in
  let file = register repo in
  List.iter
    (fun result ->
      Alcotest.(check bool)
        "foreign/missing/prefix refused" true (result.code <> 0))
    [
      resolve ~product:"gateway" repo file;
      resolve ~project:"P-ffff" repo file;
      resolve ~project:"P-5e" repo file;
    ];
  append_events repo
    [
      {|{"ts":"2026-11-12T00:00:00Z","task":"P-aabb","type":"project_created","title":"First delivery","product":"gateway","category":"platform"}|};
    ];
  Alcotest.(check bool)
    "homonym never selects another project" true
    ((resolve ~project:"P-aabb" repo file).code <> 0)

let replacement () =
  let repo = copy_fixture () in
  let file = register repo in
  let clone = copy_fixture () in
  Unix.mkdir (Filename.concat clone.wl_home ".git") 0o700;
  Alcotest.(check bool)
    "clone cannot reuse registration" true
    ((resolve clone file).code <> 0);
  Unix.rename
    (Filename.concat repo.wl_home ".git")
    (Filename.concat repo.wl_home ".git-old");
  Unix.mkdir (Filename.concat repo.wl_home ".git") 0o700;
  Alcotest.(check bool)
    "repository object replacement refuses" true
    ((resolve repo file).code <> 0)

let unsafe () =
  let repo = copy_fixture () in
  let file = register repo in
  Unix.chmod file 0o644;
  Alcotest.(check bool)
    "public registration refuses" true
    ((resolve repo file).code <> 0);
  Unix.chmod file 0o600;
  let link = Filename.concat repo.home "symlink" in
  Unix.symlink file link;
  Alcotest.(check bool)
    "symlink registration refuses" true
    ((resolve repo link).code <> 0)

let tests =
  List.map
    (fun (name, test) -> Alcotest.test_case name `Quick test)
    [
      ("canonical read-only context", canonical);
      ("unregistered", absent);
      ("exact product/project", exact);
      ("clone and replacement", replacement);
      ("unsafe registration", unsafe);
    ]
