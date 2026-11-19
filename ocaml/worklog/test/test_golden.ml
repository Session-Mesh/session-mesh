(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Compatibility evidence with the real `wl` tool. golden/repo is a small
   fictional data repository that `wl` itself wrote (commands in
   docs/worklog-format.md); golden/*.json are the outputs of `wl ls --json`,
   `wl resume --json` and `wl project ls --json` on it, with the clock
   2026-11-10T12:00:00Z, host lab, and the session directory below.

   The tests read that repository with this library and compare field by
   field, and write the same operations with this library into a fresh
   repository and compare the shape of the files with what `wl` wrote. They
   need neither `wl` nor Python. *)

open Mesh_worklog
open Tutil

let golden_repo = copy_of (Filename.concat "golden" "repo") "wlgolden"
let now = ts "2026-11-10T12:00:00Z"
let session_dir = "/tmp/wl-demo/project"

(* Compare JSON without regard to the order of object keys. *)
let rec normalize : Yojson.Safe.t -> Yojson.Safe.t = function
  | `Assoc fields ->
      `Assoc (List.sort compare (List.map (fun (k, v) -> (k, normalize v)) fields))
  | `List l -> `List (List.map normalize l)
  | other -> other

let golden name = Yojson.Safe.from_string (read_file (Filename.concat "golden" (name ^ ".json")))
let str = function Some s -> `String s | None -> `Null
let strs l = `List (List.map (fun s -> `String s) l)
let golden_ctx () = ctx ~host:"lab" ~now golden_repo

let snapshot_world () = (ok (Reader.snapshot (golden_ctx ()))).Reader.loaded.Store.world

(* The fields `wl` prints for a task, in `ls --json` and in resume rows. *)
let task_fields world (t : Model.task) =
  let project_title =
    Option.bind t.project_id (fun id ->
        Option.map (fun (p : Model.project) -> p.title_p) (Model.Smap.find_opt id world.Model.projects))
  in
  [ ("id", `String t.id); ("title", `String t.title); ("project", `String t.product);
    ("category", `String t.category); ("priority", `String t.priority);
    ("status", `String t.status); ("due", str t.due); ("product", `String t.product);
    ("project_id", str t.project_id); ("project_title", str project_title);
    ("track", str t.track); ("owner", `String t.owner); ("eta", str t.eta);
    ("size", str t.size); ("origin", str t.origin); ("also", strs t.also); ("linear", `List []) ]

let ls_json world (t : Model.task) =
  `Assoc
    (task_fields world t
    @ [ ("tags", strs t.tags); ("links", strs t.links); ("blocked_by", strs t.blocked_by) ])

let blocker_json (b : Model.blocker) =
  `Assoc [ ("id", `String b.blocker_id); ("kind", `String b.kind); ("on", str b.on); ("text", `String b.text) ]

let drop_keys keys = function
  | `Assoc fields -> `Assoc (List.filter (fun (k, _) -> not (List.mem k keys)) fields)
  | other -> other

(* The blocker age is a display string that this library does not render. *)
let without_age = function
  | `Assoc fields ->
      `Assoc
        (List.map
           (function
             | "blockers", `List bs -> ("blockers", `List (List.map (drop_keys [ "age" ]) bs))
             | other -> other)
           fields)
  | other -> other

let row_json world (r : Resume.row) =
  `Assoc
    (task_fields world r.task
    @ [ ("days", `Int r.days); ("last_note", str r.last_note);
        ("tier", match r.tier with Some t -> `Int t | None -> `Null);
        ("blockers", `List (List.map blocker_json r.open_blockers)); ("unblock", `Bool r.unblock) ])

let check_json name expected actual =
  Alcotest.(check string) name
    (Yojson.Safe.pretty_to_string (normalize expected))
    (Yojson.Safe.pretty_to_string (normalize actual))

let test_ls_matches_wl () =
  let world = snapshot_world () in
  let list filter =
    `List (List.map (ls_json world) (fst (ok (Reader.list_tasks (golden_ctx ()) filter))))
  in
  (* Order is part of the output: compare as written, then normalise the rows. *)
  check_json "ls --all --json" (golden "ls-all") (list { Query.no_filter with include_closed = true });
  check_json "ls --json" (golden "ls") (list Query.no_filter)

let where =
  { Resume.host = "lab"; cwd = session_dir; home = None; session = None; repo = None; branch = None }

let sections world (r : Resume.report) =
  let rows l = `List (List.map (row_json world) l) in
  `Assoc
    [ ("here", rows r.here); ("in_progress", rows r.in_progress); ("blocked", rows r.blocked);
      ("stale", rows r.stale); ("due", rows r.due); ("todo", rows r.todo) ]

let golden_sections name =
  match golden name with
  | `Assoc fields -> (
      match List.assoc_opt "sections" fields with
      | Some (`Assoc sections) ->
          `Assoc (List.map (fun (k, v) -> (k, match v with `List rows -> `List (List.map without_age rows) | v -> v)) sections)
      | _ -> Alcotest.fail "no sections")
  | _ -> Alcotest.fail "not an object"

let test_resume_matches_wl () =
  let world = snapshot_world () in
  let report ?show_all () = fst (ok (Reader.resume (golden_ctx ()) ~where ?show_all ())) in
  check_json "resume --json" (golden_sections "resume") (sections world (report ()));
  check_json "resume --json --all" (golden_sections "resume-all") (sections world (report ~show_all:true ()))

let project_json (row : Query.project_row) =
  let p = row.project in
  `Assoc
    [ ("id", `String p.pid); ("title", `String p.title_p); ("product", `String p.product_p);
      ("category", `String p.category_p); ("status", `String p.status_p); ("quarter", str p.quarter);
      ("owner", str p.owner_p); ("hlp", str p.hlp); ("goal", str p.goal);
      ("milestones", strs p.milestones); ("risks", strs p.risks); ("created", `String p.created_p);
      ("open_tasks", `Int row.open_tasks); ("linear", `List []) ]

let test_projects_match_wl () =
  let rows, _ = ok (Reader.list_projects (golden_ctx ()) ()) in
  check_json "project ls --json" (golden "project-ls") (`List (List.map project_json rows))

let test_golden_loads_without_warnings () =
  let loaded = (ok (Reader.snapshot (golden_ctx ()))).Reader.warnings in
  Alcotest.(check (list string)) "no warning" [] loaded;
  Alcotest.(check (list string)) "no malformed line" [] (Store.scan_malformed (golden_ctx ()))

(* ---- files written by this library read like the ones `wl` wrote -------- *)

let replay root =
  let at host moment = ctx ~host ~now:(ts moment) root in
  let lab = at "lab" and desk = at "desk" in
  let project c product title ?quarter ?goal ?milestones m =
    ok (Write_project.add (c m) ~title ~product ?quarter ?goal ?milestones ())
  in
  let p1 = project lab "gateway" "Gateway rollout" ~quarter:"2026Q4" ~goal:"Ship the gateway" ~milestones:[ "alpha" ] "2026-11-02T09:00:00Z" in
  let p2 = project lab "2fa" "Second factor" "2026-11-02T09:05:00Z" in
  let task c m title product priority status ?due ?project ?track ?tags ?links ?also ?notes () =
    ok (Write_task.add (c m) ~title ~product ~priority ~status ?due ?project ?track ?tags ?links ?also ?notes ())
  in
  let a =
    task lab "2026-11-03T09:00:00Z" "Design the token endpoint" "gateway-api" "P1" "in_progress"
      ~project:p1 ~track:"auth" ~tags:[ "api" ] ~links:[ "https://example.org/spec" ] ~notes:"First notes." ()
  in
  let b = task desk "2026-11-03T09:10:00Z" "Build the login screen" "gateway-ui" "P2" "in_progress" ~project:p1 () in
  let c3 = task lab "2026-11-03T09:20:00Z" "Enrol authenticator apps" "2fa" "P1" "todo" ~due:"2026-11-12" ~project:p2 () in
  let d = task lab "2026-11-03T09:30:00Z" "Invoice export" "billing" "P3" "todo" () in
  let e = task desk "2026-11-03T09:40:00Z" "Survey the literature" "notebook" "P2" "in_progress" () in
  let f = task lab "2026-11-03T09:50:00Z" "Triage tax feedback" "billing" "P2" "inbox" () in
  let g = task lab "2026-11-03T10:00:00Z" "Rate limiting" "gateway-api" "P2" "todo" ~also:[ "billing" ] () in
  ignore (ok (Write_task.log (lab "2026-11-04T10:00:00Z") ~task:a "Drafted the request flow"));
  ignore (ok (Write_task.note (lab "2026-11-04T10:05:00Z") ~task:a "Remember the refresh token rotation"));
  ignore (ok (Write_task.block (desk "2026-11-04T11:00:00Z") ~task:b ~kind:"decision" ~on:"design" "Waiting for the visual design"));
  ignore (ok (Write_task.add_item (lab "2026-11-05T09:00:00Z") ~task:g ~field:"tags" ~value:"perf" ()));
  ignore (ok (Write_task.add_item (lab "2026-11-05T09:10:00Z") ~task:g ~field:"blocked_by" ~value:a ()));
  ignore (ok (Write_task.set (lab "2026-11-05T09:20:00Z") ~task:d ~field:"priority" ~value:(Some "P1") ()));
  ignore (ok (Write_task.set (lab "2026-11-05T09:30:00Z") ~task:d ~field:"due" ~value:(Some "2026-11-30") ()));
  ignore (ok (Write_task.set (lab "2026-11-05T09:40:00Z") ~task:f ~field:"status" ~value:(Some "dropped") ()));
  ignore (ok (Write_project.set (lab "2026-11-06T09:00:00Z") ~project:p1 ~field:"owner" ~value:(Some "mia") ()));
  ignore (ok (Write_project.add_item (lab "2026-11-06T09:10:00Z") ~project:p1 ~field:"risks" ~value:"Late design" ()));
  let session = session ~agent:"claude" ~id:"sess-0001" ~cwd:session_dir () in
  ignore (ok (Write_task.link (lab "2026-11-07T09:00:00Z") ~session ~task:a ()));
  ignore (ok (Write_task.set (lab "2026-11-09T08:00:00Z") ~task:c3 ~field:"status" ~value:(Some "in_progress") ()));
  ignore (ok (Write_task.set (desk "2026-11-09T08:30:00Z") ~task:e ~field:"status" ~value:(Some "done") ()))

let json_lines root =
  List.map (fun raw -> Yojson.Safe.from_string raw) (event_lines root)

(* Signature of an event: its type, and the names of its keys in order. *)
let signature = function
  | `Assoc fields ->
      let typ = match List.assoc_opt "type" fields with Some (`String t) -> t | _ -> "?" in
      let field = match List.assoc_opt "field" fields with Some (`String f) -> ":" ^ f | _ -> "" in
      typ ^ field ^ " [" ^ String.concat "," (List.map fst fields) ^ "]"
  | _ -> "not an object"

let signatures root = List.sort_uniq compare (List.map signature (json_lines root))

let frontmatter_keys path = List.map fst (fst (Store.read_task_file path))

let task_files root =
  List.concat_map
    (fun p ->
      let dir = Filename.concat root ("tasks/" ^ p) in
      List.map (fun f -> (p, f, Filename.concat dir f)) (List.sort compare (Array.to_list (Sys.readdir dir))))
    (List.sort compare (List.filter (fun p -> Sys.is_directory (Filename.concat root ("tasks/" ^ p))) (Array.to_list (Sys.readdir (Filename.concat root "tasks")))))

let test_written_files_have_wl_shape () =
  let root = temp_dir "wlreplay" in
  write_file (Filename.concat root "taxonomy.yaml") (read_file (Filename.concat golden_repo "taxonomy.yaml"));
  replay root;
  Alcotest.(check (list string)) "event shapes (type, field, key order)" (signatures golden_repo) (signatures root);
  Alcotest.(check (list string)) "event files" (List.sort compare (Array.to_list (Sys.readdir (Filename.concat golden_repo "events"))))
    (List.sort compare (Array.to_list (Sys.readdir (Filename.concat root "events"))));
  let shape files = List.map (fun (p, f, path) -> (p, String.length f > 7 && String.sub f 0 2 = "T-", frontmatter_keys path)) files in
  let slugs files = List.map (fun (_, f, _) -> String.sub f 7 (String.length f - 7)) files in
  Alcotest.(check (list string)) "task file names after the id"
    (List.sort compare (slugs (task_files golden_repo)))
    (List.sort compare (slugs (task_files root)));
  Alcotest.(check bool) "task files: same directories and frontmatter keys" true
    (List.sort compare (shape (task_files golden_repo)) = List.sort compare (shape (task_files root)));
  Alcotest.(check (list string)) "no malformed line, no warning" []
    (Store.scan_malformed (ctx ~host:"lab" ~now root)
    @ (ok (Reader.snapshot (ctx ~host:"lab" ~now root))).Reader.warnings)

let test_replayed_world_matches_wl_listing () =
  let root = temp_dir "wlreplay" in
  write_file (Filename.concat root "taxonomy.yaml") (read_file (Filename.concat golden_repo "taxonomy.yaml"));
  replay root;
  (* Ids are random, so compare what does not depend on them. *)
  let rows c =
    let tasks, _ = ok (Reader.list_tasks c { Query.no_filter with include_closed = true }) in
    List.sort compare (List.map (fun (t : Model.task) -> (t.title, t.status, t.priority, t.due, t.tags, t.links, t.track, t.also)) tasks)
  in
  Alcotest.(check bool) "same tasks as the ones `wl` wrote" true
    (rows (ctx ~host:"lab" ~now root) = rows (golden_ctx ()))

let () =
  Alcotest.run "worklog golden"
    [ ( "read what wl wrote",
        [ Alcotest.test_case "loads cleanly" `Quick test_golden_loads_without_warnings;
          Alcotest.test_case "ls --json" `Quick test_ls_matches_wl;
          Alcotest.test_case "resume --json" `Quick test_resume_matches_wl;
          Alcotest.test_case "project ls --json" `Quick test_projects_match_wl ] );
      ( "write like wl",
        [ Alcotest.test_case "file shapes" `Quick test_written_files_have_wl_shape;
          Alcotest.test_case "same listing" `Quick test_replayed_world_matches_wl_listing ] ) ]
