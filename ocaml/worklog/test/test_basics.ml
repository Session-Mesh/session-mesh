(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Time, text, field validation, the YAML subset, the taxonomy, event lines,
   ids, sessions and repository discovery. *)

open Mesh_worklog
open Tutil

let json_s s : Yojson.Safe.t = `String s
let check_opt name expected actual = Alcotest.(check (option string)) name expected actual

(* ---- Tstamp ------------------------------------------------------------ *)

let test_tstamp () =
  let t = ts "2026-11-10T12:34:56Z" in
  Alcotest.(check string) "format round trip" "2026-11-10T12:34:56Z" (Tstamp.format t);
  Alcotest.(check string) "month" "2026-11" (Tstamp.month t);
  Alcotest.(check string) "date" "2026-11-10" (Tstamp.date_of t);
  Alcotest.(check (option int)) "minute precision" (Some (ts "2026-11-10T12:34:00Z"))
    (Tstamp.parse "2026-11-10T12:34Z");
  Alcotest.(check (option int)) "epoch" (Some 0) (Tstamp.parse "1970-01-01T00:00:00Z");
  List.iter
    (fun bad -> Alcotest.(check (option int)) bad None (Tstamp.parse bad))
    [ "2026-11-10"; "2026-11-10T12:34:56"; "2026-11-10T12:34:56+01:00"; "2026-13-10T00:00:00Z";
      "2026-02-30T00:00:00Z"; "2026-11-10T24:00:00Z"; "2026-11-10 12:00:00Z"; "" ];
  Alcotest.(check bool) "leap day" true (Tstamp.valid_date "2028-02-29");
  Alcotest.(check bool) "no leap day" false (Tstamp.valid_date "2027-02-29");
  Alcotest.(check string) "add days across a month" "2026-12-03" (Tstamp.add_days "2026-11-26" 7);
  Alcotest.(check string) "add days across a year" "2027-01-01" (Tstamp.add_days "2026-12-25" 7)

(* ---- Textcheck --------------------------------------------------------- *)

let test_textcheck () =
  Alcotest.(check bool) "blank" true (Textcheck.is_blank " \t\n");
  Alcotest.(check string) "strip" "a b" (Textcheck.strip "  a b\n");
  Alcotest.(check bool) "control" true (Textcheck.has_control "a\nb");
  Alcotest.(check bool) "bidi" true (Textcheck.has_control "a\xe2\x80\xaeb");
  Alcotest.(check bool) "plain accents" false (Textcheck.has_control "caf\xc3\xa9");
  Alcotest.(check bool) "name" true (Textcheck.valid_name "relay-core.v2");
  Alcotest.(check bool) "name must start alnum" false (Textcheck.valid_name "-x");
  Alcotest.(check bool) "name 101 chars" false (Textcheck.valid_name (String.make 101 'a'));
  Alcotest.(check string) "slug" "ship-the-first-delivery" (Textcheck.slugify "Ship the first delivery!");
  Alcotest.(check string) "slug accents" "reparer-cafe" (Textcheck.slugify "R\xc3\xa9parer caf\xc3\xa9");
  Alcotest.(check string) "slug empty" "" (Textcheck.slugify "???");
  Alcotest.(check int) "slug cut at 40" 40 (String.length (Textcheck.slugify (String.make 60 'a')));
  check_opt "first line" (Some "one") (Textcheck.first_line "one\ntwo");
  Alcotest.(check int) "first line cut" 80
    (Textcheck.length (Option.get (Textcheck.first_line (String.make 200 'x'))));
  Alcotest.(check bool) "body NUL" true (Textcheck.body_text_error ~what:"text" "a\000b" <> None);
  Alcotest.(check bool) "body newline ok" true (Textcheck.body_text_error ~what:"text" "a\nb" = None);
  Alcotest.(check bool) "body too long" true
    (Textcheck.body_text_error ~what:"text" (String.make 8001 'a') <> None)

(* ---- Fields ------------------------------------------------------------ *)

let test_fields () =
  let task f v = Fields.task_scalar_error f v in
  Alcotest.(check bool) "status ok" true (task "status" (json_s "waiting") = None);
  Alcotest.(check bool) "status bad" true (task "status" (json_s "bogus") <> None);
  Alcotest.(check bool) "priority P9" true (task "priority" (json_s "P9") <> None);
  Alcotest.(check bool) "due null ok" true (task "due" `Null = None);
  Alcotest.(check bool) "title null bad" true (task "title" `Null <> None);
  Alcotest.(check bool) "size XL" true (task "size" (json_s "XL") <> None);
  Alcotest.(check bool) "eta bad date" true (task "eta" (json_s "2026-02-30") <> None);
  Alcotest.(check bool) "project id" true (task "project" (json_s "P-ab12") = None);
  Alcotest.(check bool) "project not an id" true (task "project" (json_s "ab12") <> None);
  Alcotest.(check bool) "unknown field" true (task "colour" (json_s "red") <> None);
  Alcotest.(check bool) "quarter ok" true (Fields.project_scalar_error "quarter" (json_s "2026Q4") = None);
  Alcotest.(check bool) "quarter bad" true (Fields.project_scalar_error "quarter" (json_s "2026Q5") <> None);
  Alcotest.(check bool) "project status" true (Fields.project_scalar_error "status" (json_s "blocked") <> None);
  Alcotest.(check bool) "project owner null" true (Fields.project_scalar_error "owner" `Null = None);
  Alcotest.(check bool) "also needs a name" true (Fields.task_item_error "also" (json_s "a b") <> None);
  Alcotest.(check bool) "shipped needs a date" true
    (Fields.kind_error ~kind:"shipped" ~text:(Some (json_s "x")) ~date:None <> None);
  Alcotest.(check bool) "decision needs text" true
    (Fields.kind_error ~kind:"decision" ~text:(Some (json_s " ")) ~date:None <> None);
  Alcotest.(check bool) "ids" true
    (Fields.valid_task_id "T-1a2b" && (not (Fields.valid_task_id "T-12")) && Fields.valid_project_id "P-00ff")

(* ---- Yaml_lite and Taxonomy -------------------------------------------- *)

let legacy_text = "categories:\n  nl:\n    name: Some Org\n    projects: [alpha, beta]\n  personal:\n    name: Personal\n    projects:\n      - home\n"

let tree_text =
  "categories:\n  nl:\n    name: Some Org\n    products: [bounty, {garden: [dmonitor, dstack]}]\n"

let test_taxonomy_legacy_and_tree () =
  let legacy = Result.get_ok (Taxonomy.of_string legacy_text) in
  check_opt "legacy category" (Some "nl") (Taxonomy.category_of legacy "alpha");
  Alcotest.(check (list string)) "legacy descendants" [ "alpha" ] (Taxonomy.descendants legacy "alpha");
  let tree = Result.get_ok (Taxonomy.of_string tree_text) in
  check_opt "child category" (Some "nl") (Taxonomy.category_of tree "dstack");
  check_opt "root of child" (Some "garden") (Taxonomy.root_of tree "dstack");
  check_opt "root of root" (Some "garden") (Taxonomy.root_of tree "garden");
  Alcotest.(check (list string)) "roll-up" [ "garden"; "dmonitor"; "dstack" ]
    (Taxonomy.descendants tree "garden");
  Alcotest.(check (list string)) "unknown" [] (Taxonomy.descendants tree "nope");
  Alcotest.(check (list string)) "file order" [ "bounty"; "garden"; "dmonitor"; "dstack" ]
    (Taxonomy.products tree)

let test_taxonomy_block_forms () =
  let text =
    "# comment\ncategories:\n  a:\n    name: \"Quoted: name\"   # trailing\n    products:\n    - x\n    - 'y':\n      - y1\n      - y2\n\n  b:\n    name: B\n    products: []\n"
  in
  let t = Result.get_ok (Taxonomy.of_string text) in
  Alcotest.(check (list string)) "products" [ "x"; "y"; "y1"; "y2" ] (Taxonomy.products t);
  Alcotest.(check string) "quoted name" "Quoted: name" (List.hd t.categories).name;
  Alcotest.(check (list string)) "empty list valid" []
    (List.nth t.categories 1).products

let test_taxonomy_errors () =
  let bad name text =
    Alcotest.(check bool) name true (Result.is_error (Taxonomy.of_string text))
  in
  bad "depth 3" "categories:\n  a:\n    name: A\n    products:\n      - g:\n          - [x]\n";
  bad "two categories one id" "categories:\n  a:\n    name: A\n    projects: [x]\n  b:\n    name: B\n    projects: [x]\n";
  bad "both keys" "categories:\n  a:\n    name: A\n    projects: [x]\n    products: [y]\n";
  bad "neither key" "categories:\n  a:\n    name: A\n";
  bad "null child list" "categories:\n  a:\n    name: A\n    products:\n      - g:\n";
  bad "multi-key item" "categories:\n  a:\n    name: A\n    products: [{g: [x], h: [y]}]\n";
  bad "yaml boolean id" "categories:\n  a:\n    name: A\n    projects: [yes]\n";
  bad "number id" "categories:\n  a:\n    name: A\n    projects: [12]\n";
  bad "no categories key" "projects: [x]\n";
  bad "not yaml we read" "categories:\n  a:\n    name: |\n      text\n";
  bad "bad id characters" "categories:\n  a:\n    name: A\n    projects: ['a b']\n";
  Alcotest.(check bool) "quoted number is a string" true
    (Result.is_ok (Taxonomy.of_string "categories:\n  a:\n    name: A\n    projects: ['12']\n"))

let test_taxonomy_load () =
  check_error "missing file" Err.Repo (Taxonomy.load "/nonexistent/taxonomy.yaml");
  let dir = temp_dir "wltax" in
  write_file (Filename.concat dir "taxonomy.yaml") "broken: [\n";
  check_error "invalid file" Err.Usage (Taxonomy.load (Filename.concat dir "taxonomy.yaml"))

(* ---- Event lines -------------------------------------------------------- *)

let test_event_classify () =
  let bad name raw = Alcotest.(check bool) name true (Result.is_error (Event.classify raw)) in
  bad "blank" "   ";
  bad "bom" "\xef\xbb\xbf{}";
  bad "crlf" "{\"ts\":\"2026-11-10T12:00:00Z\",\"task\":\"T-1a2b\",\"type\":\"note\"}\r";
  bad "conflict marker" "<<<<<<< HEAD";
  bad "not json" "nope";
  bad "not object" "[1]";
  bad "missing type" "{\"ts\":\"2026-11-10T12:00:00Z\",\"task\":\"T-1a2b\"}";
  bad "non-string task" "{\"ts\":\"2026-11-10T12:00:00Z\",\"task\":1,\"type\":\"note\"}";
  bad "bad ts" "{\"ts\":\"yesterday\",\"task\":\"T-1a2b\",\"type\":\"note\"}";
  bad "invalid utf-8" "{\"ts\":\"2026-11-10T12:00:00Z\",\"task\":\"T-1a2b\",\"type\":\"\xff\"}";
  match Event.classify "{\"ts\":\"2026-11-10T12:00Z\",\"task\":\"T-1a2b\",\"type\":\"note\",\"text\":\"x\"}" with
  | Ok (_, t) -> Alcotest.(check int) "minute precision accepted" (ts "2026-11-10T12:00:00Z") t
  | Error why -> Alcotest.failf "unexpected: %s" why

let test_event_encode () =
  let line =
    Event.encode ~ts:(ts "2026-11-10T12:00:00Z") ~task:"T-1a2b" ~typ:"progress"
      [ ("text", json_s "caf\xc3\xa9 \"quoted\"\nline2"); ("agent", json_s "claude") ]
  in
  Alcotest.(check bool) "no raw newline" false (String.contains line '\n');
  Alcotest.(check bool) "keys in order, UTF-8 kept" true
    (contains ~sub:"{\"ts\":\"2026-11-10T12:00:00Z\",\"task\":\"T-1a2b\",\"type\":\"progress\",\"text\":\"caf\xc3\xa9" line);
  match Event.classify line with
  | Ok (fields, _) ->
      Alcotest.(check (option string)) "text survives" (Some "caf\xc3\xa9 \"quoted\"\nline2")
        (match List.assoc_opt "text" fields with Some (`String s) -> Some s | _ -> None)
  | Error why -> Alcotest.failf "unexpected: %s" why

(* ---- Ids, sessions, context --------------------------------------------- *)

let test_ids () =
  let rng = Random.State.make [| 1 |] in
  let id = Ids.task rng ~taken:[] in
  Alcotest.(check int) "T- and four digits" 6 (String.length id);
  (* Taking every four-digit id forces the fifth digit. *)
  let all4 = List.init 65536 (Printf.sprintf "%04x") in
  let long = Ids.task rng ~taken:all4 in
  Alcotest.(check int) "extends after collisions" 7 (String.length long);
  Alcotest.(check int) "blocker six digits" 8 (String.length (Ids.blocker rng ~taken:[]));
  Alcotest.(check bool) "project prefix" true ((Ids.project rng ~taken:[]).[0] = 'P')

let env_of l name = List.assoc_opt name l

let test_session_resolve () =
  let r getenv ?agent ?session () = Result.get_ok (Session.resolve ~getenv ?agent ?session ()) in
  Alcotest.(check bool) "nothing" true (r (env_of []) () = None);
  let s = Option.get (r (env_of [ ("CLAUDE_CODE_SESSION_ID", "abc") ]) ()) in
  Alcotest.(check (pair string (option string))) "claude env" ("claude", Some "abc") (s.agent, s.session);
  let s = Option.get (r (env_of [ ("WL_AGENT", "opencode"); ("WL_SESSION", "ses_x"); ("CLAUDE_CODE_SESSION_ID", "abc") ]) ()) in
  Alcotest.(check (pair string (option string))) "WL_ beats env" ("opencode", Some "ses_x") (s.agent, s.session);
  let s = Option.get (r (env_of [ ("WL_SESSION", "w") ]) ~agent:"codex" ~session:"arg" ()) in
  Alcotest.(check (pair string (option string))) "arguments win" ("codex", Some "arg") (s.agent, s.session);
  let s = Option.get (r (env_of [ ("CLAUDE_CODE_SESSION_ID", ""); ("OPENCODE_SESSION_ID", "oc") ]) ()) in
  Alcotest.(check string) "empty counts as unset" "opencode" s.agent;
  check_error "session without agent" Err.Usage (Session.resolve ~getenv:(env_of [ ("WL_SESSION", "x") ]) ());
  check_error "bad agent" Err.Usage (Session.make ~agent:"Bad Agent" ());
  check_error "bad session" Err.Usage (Session.make ~agent:"a" ~session:"-x" ())

let test_ctx_discovery () =
  let home = temp_dir "wlhome" in
  let data = Filename.concat home "worklog-data" in
  write_file (Filename.concat data "taxonomy.yaml") "categories:\n  a:\n    name: A\n    projects: [p]\n";
  let env extra name = List.assoc_opt name ([ ("HOME", home) ] @ extra) in
  let c = ok (Ctx.of_env ~getenv:(env []) ()) in
  Alcotest.(check string) "default data repo" data c.root;
  let explicit = temp_dir "wlexplicit" in
  write_file (Filename.concat explicit "taxonomy.yaml") "categories:\n  a:\n    name: A\n    projects: [p]\n";
  let c = ok (Ctx.of_env ~getenv:(env [ ("WL_HOME", explicit); ("WL_HOST", "Box.Example.org"); ("WL_NOW", "2026-11-10T10:00:00Z") ]) ()) in
  Alcotest.(check string) "WL_HOME" explicit c.root;
  (* WL_HOST is normalised but, as in wl, not cut at its first dot. *)
  Alcotest.(check string) "host normalised" "box-example-org" c.host;
  Alcotest.(check int) "WL_NOW" (ts "2026-11-10T10:00:00Z") (c.now ());
  check_error "WL_HOME without taxonomy" Err.Repo (Ctx.of_env ~getenv:(env [ ("WL_HOME", home) ]) ());
  check_error "bad WL_NOW" Err.Usage (Ctx.of_env ~getenv:(env [ ("WL_NOW", "now") ]) ());
  let legacy = Filename.concat home "worklog" in
  write_file (Filename.concat legacy "taxonomy.yaml") "categories:\n  a:\n    name: A\n    projects: [p]\n";
  check_error "both default repos" Err.Repo (Ctx.of_env ~getenv:(env []) ());
  let empty_home = temp_dir "wlempty" in
  check_error "no repo, cwd never used" Err.Repo (Ctx.of_env ~getenv:(env_of [ ("HOME", empty_home) ]) ());
  Alcotest.(check string) "host helper" "host" (Ctx.host_name "")

let () =
  Alcotest.run "worklog basics"
    [ ( "time and text",
        [ Alcotest.test_case "timestamps and dates" `Quick test_tstamp;
          Alcotest.test_case "text rules" `Quick test_textcheck;
          Alcotest.test_case "field validation" `Quick test_fields ] );
      ( "taxonomy",
        [ Alcotest.test_case "legacy and tree" `Quick test_taxonomy_legacy_and_tree;
          Alcotest.test_case "block forms and comments" `Quick test_taxonomy_block_forms;
          Alcotest.test_case "refused shapes" `Quick test_taxonomy_errors;
          Alcotest.test_case "load errors" `Quick test_taxonomy_load ] );
      ( "events",
        [ Alcotest.test_case "malformed lines" `Quick test_event_classify;
          Alcotest.test_case "encoding" `Quick test_event_encode ] );
      ( "identity",
        [ Alcotest.test_case "ids" `Quick test_ids;
          Alcotest.test_case "session resolution" `Quick test_session_resolve;
          Alcotest.test_case "repository discovery" `Quick test_ctx_discovery ] ) ]
