(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Regression tests of the hardening pass: symbolic links and special files,
   readers that never raise, briefing order, caller input, discovery, locking
   and the git subprocess. Each case failed before its fix. *)

open Mesh_worklog
open Tutil

let line ts task typ rest =
  Printf.sprintf "{\"ts\":\"%s\",\"task\":\"%s\",\"type\":\"%s\"%s}" ts task typ rest

let created ts id product status prio =
  line ts id "created"
    (Printf.sprintf
       ",\"title\":\"t %s\",\"project\":\"%s\",\"category\":\"platform\",\"priority\":\"%s\",\"status\":\"%s\""
       id product prio status)

let taxonomy_text =
  "categories:\n  platform:\n    name: Platform\n    products:\n      - alpha\n      - zeta\n"

let repo_with lines =
  let root = temp_dir "hard" in
  write_file (Filename.concat root "taxonomy.yaml") taxonomy_text;
  write_file (Filename.concat root "events/2026-11.hosta.jsonl") (String.concat "\n" lines ^ "\n");
  root

let one_task_repo () = repo_with [ created "2026-11-01T10:00:00Z" "T-aaaa" "alpha" "todo" "P2" ]
let later = ts "2026-11-02T10:00:00Z"
let is_error = function Ok _ -> false | Error _ -> true

(* ---- symbolic links and special files ------------------------------------ *)

let test_symlinked_task_file () =
  let root = one_task_repo () in
  let secret = Filename.concat (temp_dir "secret") "private.txt" in
  write_file secret "---\nid: T-aaaa\n---\nOUTSIDE-SECRET-CONTENT\n";
  Appendfile.mkdir_p (Filename.concat root "tasks/alpha");
  Unix.symlink secret (Filename.concat root "tasks/alpha/T-aaaa-x.md");
  let view, warnings = ok (Reader.get_task (ctx root) "aaaa") in
  Alcotest.(check bool) "secret not read" false (contains ~sub:"OUTSIDE-SECRET" view.Query.notes);
  Alcotest.(check bool) "refusal reported" true (has_warning ~sub:"tasks/alpha/T-aaaa-x.md" warnings);
  match Store.read_task_file (Filename.concat root "tasks/alpha/T-aaaa-x.md") with
  | exception Err.E _ -> ()
  | _ -> Alcotest.fail "a direct read followed the link"

let test_symlinked_events_dir () =
  let root = one_task_repo () in
  let outside = temp_dir "outside" in
  Sys.rename (Filename.concat root "events") (Filename.concat outside "ev");
  Unix.symlink (Filename.concat outside "ev") (Filename.concat root "events");
  let before = read_file (Filename.concat outside "ev/2026-11.hosta.jsonl") in
  Alcotest.(check bool) "write refused" true
    (is_error (Write_task.log (ctx ~now:later root) ~task:"aaaa" "hello"));
  (match Appendfile.append ~root (Filename.concat root "events/2026-11.hosta.jsonl") "x\n" with
  | exception Err.E _ -> ()
  | () -> Alcotest.fail "append through a linked events/ was accepted");
  Alcotest.(check string) "outside file untouched" before
    (read_file (Filename.concat outside "ev/2026-11.hosta.jsonl"));
  let tasks, warnings = ok (Reader.list_tasks (ctx root) Query.no_filter) in
  Alcotest.(check int) "events not read through the link" 0 (List.length tasks);
  Alcotest.(check bool) "refusal reported" true (has_warning ~sub:"events" warnings)

let test_symlinked_product_dir () =
  let root = one_task_repo () in
  let outside = temp_dir "outside" in
  Appendfile.mkdir_p (Filename.concat root "tasks");
  Unix.symlink outside (Filename.concat root "tasks/zeta");
  check_error "add refused" Err.Other
    (Write_task.add (ctx ~now:later root) ~title:"new" ~product:"zeta" ());
  Alcotest.(check (list string)) "nothing created outside" [] (Array.to_list (Sys.readdir outside))

let test_symlinked_lock_file () =
  let root = one_task_repo () in
  let target = Filename.concat (temp_dir "locktarget") "created-by-lock" in
  Unix.symlink target (Filename.concat root ".wl.lock");
  check_error "write refused" Err.Other (Write_task.log (ctx ~now:later root) ~task:"aaaa" "x");
  Alcotest.(check bool) "target not created" false (Sys.file_exists target)

let test_symlinked_event_file () =
  let root = one_task_repo () in
  let outside = Filename.concat (temp_dir "outside") "events.jsonl" in
  write_file outside (created "2026-11-01T11:00:00Z" "T-bbbb" "alpha" "todo" "P2" ^ "\n");
  Unix.symlink outside (Filename.concat root "events/2026-11.hostb.jsonl");
  let tasks, warnings = ok (Reader.list_tasks (ctx root) Query.no_filter) in
  Alcotest.(check (list string)) "only the regular file's task" [ "T-aaaa" ]
    (List.map (fun (t : Model.task) -> t.id) tasks);
  Alcotest.(check bool) "refusal reported" true (has_warning ~sub:"hostb.jsonl" warnings);
  let before = read_file outside in
  (match Appendfile.append (Filename.concat root "events/2026-11.hostb.jsonl") "x\n" with
  | exception Err.E _ -> ()
  | () -> Alcotest.fail "append through a link was accepted");
  Alcotest.(check string) "link target untouched" before (read_file outside)

let test_dangling_event_link () =
  let root = one_task_repo () in
  let target = Filename.concat (temp_dir "outside") "never-created" in
  let link = Filename.concat root "events/2026-11.hosta.jsonl" in
  Sys.remove link;
  Unix.symlink target link;
  (match Appendfile.append link "x\n" with
  | exception (Err.E _ | Unix.Unix_error _) -> ()
  | () -> Alcotest.fail "append through a dangling link was accepted");
  Alcotest.(check bool) "target not created" false (Sys.file_exists target)

let test_fifo_event_file () =
  let root = one_task_repo () in
  Unix.mkfifo (Filename.concat root "events/2026-11.hostb.jsonl") 0o644;
  let tasks, warnings = ok (Reader.list_tasks (ctx root) Query.no_filter) in
  Alcotest.(check int) "read does not block and skips the fifo" 1 (List.length tasks);
  Alcotest.(check bool) "refusal reported" true (has_warning ~sub:"hostb.jsonl" warnings)

let test_taxonomy_edit_still_refuses_outside_link () =
  let root = one_task_repo () in
  let outside = Filename.concat (temp_dir "outside") "taxonomy.yaml" in
  write_file outside taxonomy_text;
  Sys.remove (Filename.concat root "taxonomy.yaml");
  Unix.symlink outside (Filename.concat root "taxonomy.yaml");
  check_error "edit refused" Err.Usage (Taxonomy_edit.add_product (ctx root) ~id:"gamma" ~category:"platform" ());
  Alcotest.(check string) "outside taxonomy untouched" taxonomy_text (read_file outside)

(* ---- readers never raise ------------------------------------------------- *)

let unreadable_dir_repo () =
  let root = one_task_repo () in
  let dir = Filename.concat root "tasks/zeta" in
  Appendfile.mkdir_p dir;
  write_file (Filename.concat dir "T-bbbb.md") "x";
  Unix.chmod dir 0o000;
  (root, dir)

let can_read dir = match Sys.readdir dir with _ -> true | exception Sys_error _ -> false

let test_readers_return_error_on_unreadable_dir () =
  let root, dir = unreadable_dir_repo () in
  Fun.protect
    ~finally:(fun () -> Unix.chmod dir 0o755)
    (fun () ->
      if can_read dir then () (* running as root: permissions do not apply *)
      else begin
        let c = ctx root in
        Alcotest.(check bool) "list_tasks" true (is_error (Reader.list_tasks c Query.no_filter));
        Alcotest.(check bool) "get_task" true (is_error (Reader.get_task c "aaaa"));
        Alcotest.(check bool) "resume" true (is_error (Reader.resume c ()));
        Alcotest.(check bool) "list_projects" true (is_error (Reader.list_projects c ()));
        Alcotest.(check bool) "get_project" true (is_error (Reader.get_project c "P-1234"));
        Alcotest.(check bool) "snapshot" true (is_error (Reader.snapshot c))
      end)

let test_scan_malformed_survives_a_directory_named_jsonl () =
  let root = one_task_repo () in
  Appendfile.mkdir_p (Filename.concat root "events/2026-11.hostb.jsonl");
  let problems = Store.scan_malformed (ctx root) in
  Alcotest.(check int) "no exception, no problem for a skipped entry" 0 (List.length problems)

(* ---- briefing order ------------------------------------------------------ *)

let test_briefing_order_counts_only_shown_tasks () =
  let root =
    repo_with
      [ created "2026-11-01T10:00:00Z" "T-aaaa" "zeta" "in_progress" "P1";
        created "2026-11-01T10:00:01Z" "T-bbbb" "alpha" "in_progress" "P2";
        created "2026-11-01T10:00:02Z" "T-cccc" "alpha" "todo" "P2";
        line "2026-11-01T10:00:03Z" "T-cccc" "set" ",\"field\":\"project\",\"to\":\"P-1234\"" ]
  in
  let report, _ = ok (Reader.resume (ctx ~now:later root) ()) in
  Alcotest.(check (list string)) "priority order, not product order (the todo task is in no section)"
    [ "T-aaaa"; "T-bbbb" ]
    (List.map (fun (r : Resume.row) -> r.task.Model.id) report.Resume.in_progress);
  let shown, _ = ok (Reader.resume (ctx ~now:later root) ~show_all:true ()) in
  Alcotest.(check (list string)) "with the todo task shown the placement order applies"
    [ "T-bbbb"; "T-aaaa" ]
    (List.map (fun (r : Resume.row) -> r.task.Model.id) shown.Resume.in_progress)

(* ---- caller input -------------------------------------------------------- *)

let test_session_text_validation () =
  let bad name r = check_error name Err.Usage r in
  bad "control characters in cwd" (Session.make ~agent:"claude" ~cwd:"/tmp/a\x1b[31mred\nnext" ());
  bad "20 kB cwd" (Session.make ~agent:"claude" ~cwd:("/tmp/" ^ String.make 20000 'x') ());
  bad "newline in branch" (Session.make ~agent:"claude" ~branch:"main\nevil" ());
  bad "long branch" (Session.make ~agent:"claude" ~branch:(String.make 300 'b') ());
  bad "control character in repo" (Session.make ~agent:"claude" ~repo:"/r\x00" ());
  ignore (ok (Session.make ~agent:"claude" ~cwd:"/home/me/projet été" ~repo:"/home/me/r" ~branch:"feat/x-1" ()))

let strict_json_cases =
  [ ("trailing comment", {|{"ts":"2026-11-01T10:00:00Z","task":"T-aaaa","type":"note","text":"x"} /* c */|});
    ("inner comment", {|{"ts":"2026-11-01T10:00:00Z",/* c */"task":"T-aaaa","type":"note","text":"x"}|});
    ("line comment", "{\"ts\":\"2026-11-01T10:00:00Z\",\"task\":\"T-aaaa\",\"type\":\"note\",\"text\":\"x\"} // c");
    ("tuple", {|{"ts":"2026-11-01T10:00:00Z","task":"T-aaaa","type":"note","n":(1,2)}|});
    ("variant", {|{"ts":"2026-11-01T10:00:00Z","task":"T-aaaa","type":"note","n":<"A":1>}|}) ]

let test_event_reader_rejects_non_json () =
  List.iter
    (fun (name, raw) ->
      match Event.classify raw with
      | Error _ -> ()
      | Ok _ -> Alcotest.failf "%s was accepted" name)
    strict_json_cases;
  let accepted = {|{"ts":"2026-11-01T10:00:00Z","task":"T-aaaa","type":"note","text":"a // b /* c */","n":[1.5e3,-2,null,true]}|} in
  Alcotest.(check bool) "slashes inside strings are fine" true (Result.is_ok (Event.classify accepted));
  let root = repo_with (created "2026-11-01T10:00:00Z" "T-aaaa" "alpha" "todo" "P2" :: List.map snd strict_json_cases) in
  let loaded = Store.load (ctx root) in
  Alcotest.(check int) "commented lines skipped with a warning" (List.length strict_json_cases)
    (List.length (List.filter (contains ~sub:"skipped malformed line") loaded.Store.warnings))

(* ---- discovery and clock ------------------------------------------------- *)

let env_of pairs name = List.assoc_opt name pairs

let test_wl_host_is_not_cut () =
  let root = one_task_repo () in
  let host pairs = (ok (Ctx.of_env ~getenv:(env_of (("WL_HOME", root) :: pairs)) ~commit:false ())).Ctx.host in
  Alcotest.(check string) "WL_HOST keeps its dots as dashes" "lab-one" (host [ ("WL_HOST", "lab.one") ]);
  Alcotest.(check string) "uppercase" "lab-one" (host [ ("WL_HOST", "Lab.ONE") ]);
  Alcotest.(check string) "one dash per code point" "h-te" (host [ ("WL_HOST", "h\xc3\xb4te") ]);
  Alcotest.(check string) "system host name is cut at the first dot" "lab" (Ctx.host_name "lab.example.org")

let test_empty_home_gives_no_relative_path () =
  (* A repository sits at ./worklog-data: an empty HOME must not find it there. *)
  let cwd = Sys.getcwd () and dir = temp_dir "homeless" in
  write_file (Filename.concat dir "worklog-data/taxonomy.yaml") taxonomy_text;
  Unix.chdir dir;
  Fun.protect
    ~finally:(fun () -> Unix.chdir cwd)
    (fun () ->
      match Ctx.of_env ~getenv:(env_of [ ("HOME", "") ]) ~commit:false () with
      | Error _ -> ()
      | Ok c -> Alcotest.(check bool) "absolute root" true (not (Filename.is_relative c.Ctx.root)))

let test_directory_named_taxonomy_is_not_a_repo () =
  let root = temp_dir "notrepo" in
  Appendfile.mkdir_p (Filename.concat root "taxonomy.yaml");
  check_error "not a repo" Err.Repo (Ctx.of_env ~getenv:(env_of [ ("WL_HOME", root) ]) ~commit:false ())

let test_lock_timeout_is_finite () =
  let root = one_task_repo () in
  let timeout v =
    (ok (Ctx.of_env ~getenv:(env_of [ ("WL_HOME", root); ("WL_LOCK_TIMEOUT", v) ]) ~commit:false ())).Ctx.lock_timeout
  in
  Alcotest.(check (float 0.)) "nan" 30.0 (timeout "nan");
  Alcotest.(check (float 0.)) "inf" 30.0 (timeout "inf");
  Alcotest.(check (float 0.)) "negative waits no time" 0.0 (timeout "-5");
  Alcotest.(check (float 0.)) "plain number" 2.5 (timeout "2.5");
  Alcotest.(check (float 0.)) "make sanitises too" 30.0
    (Ctx.make ~root ~lock_timeout:infinity ()).Ctx.lock_timeout

(* The open descriptors of this process: /proc/self/fd on Linux, /dev/fd on
   macOS, which has no /proc. Both listings count the descriptor that reads
   them, the same way before and after. *)
let fd_directory = if Sys.file_exists "/proc/self/fd" then "/proc/self/fd" else "/dev/fd"

let open_fds () = Array.length (Sys.readdir fd_directory)

let test_lock_leaks_no_descriptor () =
  let root = one_task_repo () in
  let path = Ctx.lock_path (ctx root) in
  let before = open_fds () in
  for _ = 1 to 20 do
    (try Lock.with_lock ~path ~timeout:0.0 (fun () ->
         (* held: a second attempt through another descriptor times out *)
         Lock.with_lock ~path ~timeout:0.01 (fun () -> ()))
     with Err.E _ -> ());
    (try Lock.with_lock ~path:"/dev/null" ~timeout:0.0 (fun () -> ()) with Err.E _ -> ())
  done;
  Alcotest.(check int) "descriptors" before (open_fds ())

let test_monotonic_clock () =
  let a = Lock.monotonic () in
  let b = Lock.monotonic () in
  Alcotest.(check bool) "never goes back" true (b >= a)

(* ---- the git subprocess --------------------------------------------------- *)

let test_git_timeout () =
  let dir = temp_dir "gitt" in
  let started = Unix.gettimeofday () in
  let code, out =
    Gitrun.run ~timeout:1.0 ~dir [ "-c"; "alias.hang=!sleep 3"; "hang" ]
  in
  Alcotest.(check int) "timed out" 124 code;
  Alcotest.(check bool) "message" true (contains ~sub:"timed out" out);
  Alcotest.(check bool) "returned at the deadline" true (Unix.gettimeofday () -. started < 2.5)

let test_git_environment_is_scrubbed () =
  let dir = temp_dir "gite" in
  ignore (Gitrun.run ~dir [ "init"; "-q" ]);
  Unix.putenv "GIT_CONFIG_COUNT" "1";
  Unix.putenv "GIT_CONFIG_KEY_0" "user.name";
  Unix.putenv "GIT_CONFIG_VALUE_0" "injected-name";
  Unix.putenv "GIT_PREFIX" "injected-prefix/";
  let _, name = Gitrun.run ~dir [ "config"; "user.name" ] in
  Alcotest.(check bool) "configuration not injected" false (contains ~sub:"injected-name" name);
  let _, env = Gitrun.run ~dir [ "-c"; "alias.e=!env"; "e" ] in
  Alcotest.(check bool) "GIT_PREFIX not inherited" false (contains ~sub:"injected-prefix" env);
  Alcotest.(check bool) "GIT_CONFIG_COUNT not inherited" false (contains ~sub:"GIT_CONFIG_COUNT" env)

let () =
  Alcotest.run "worklog hardening"
    [ ( "symlinks",
        [ Alcotest.test_case "symlinked task file" `Quick test_symlinked_task_file;
          Alcotest.test_case "symlinked events directory" `Quick test_symlinked_events_dir;
          Alcotest.test_case "symlinked product directory" `Quick test_symlinked_product_dir;
          Alcotest.test_case "symlinked lock file" `Quick test_symlinked_lock_file;
          Alcotest.test_case "symlinked event file" `Quick test_symlinked_event_file;
          Alcotest.test_case "dangling event link" `Quick test_dangling_event_link;
          Alcotest.test_case "fifo event file" `Quick test_fifo_event_file;
          Alcotest.test_case "taxonomy edit outside link" `Quick test_taxonomy_edit_still_refuses_outside_link ] );
      ( "never raise",
        [ Alcotest.test_case "unreadable directory" `Quick test_readers_return_error_on_unreadable_dir;
          Alcotest.test_case "directory named jsonl" `Quick test_scan_malformed_survives_a_directory_named_jsonl ] );
      ( "briefing", [ Alcotest.test_case "order counts shown tasks" `Quick test_briefing_order_counts_only_shown_tasks ] );
      ( "input",
        [ Alcotest.test_case "session text" `Quick test_session_text_validation;
          Alcotest.test_case "strict json" `Quick test_event_reader_rejects_non_json ] );
      ( "discovery",
        [ Alcotest.test_case "WL_HOST" `Quick test_wl_host_is_not_cut;
          Alcotest.test_case "empty HOME" `Quick test_empty_home_gives_no_relative_path;
          Alcotest.test_case "taxonomy.yaml directory" `Quick test_directory_named_taxonomy_is_not_a_repo;
          Alcotest.test_case "lock timeout" `Quick test_lock_timeout_is_finite ] );
      ( "lock and git",
        [ Alcotest.test_case "no descriptor leak" `Quick test_lock_leaks_no_descriptor;
          Alcotest.test_case "monotonic clock" `Quick test_monotonic_clock;
          Alcotest.test_case "git timeout" `Quick test_git_timeout;
          Alcotest.test_case "git environment" `Quick test_git_environment_is_scrubbed ] ) ]
