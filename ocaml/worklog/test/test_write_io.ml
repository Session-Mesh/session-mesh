(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Writers at the file level: concurrency, locking, torn lines, git commits,
   initialisation. *)

open Mesh_worklog
open Tutil

let hosta_file root = Filename.concat root "events/2026-11.hosta.jsonl"
let nonempty_lines s = List.filter (fun l -> l <> "") (String.split_on_char '\n' s)

(* ---- concurrency --------------------------------------------------------- *)

let spawn f =
  match Unix.fork () with
  | 0 -> (
      (* A child never returns into the test runner. *)
      try f (); Unix._exit 0 with _ -> Unix._exit 2)
  | pid -> pid

let wait_ok pid =
  match Unix.waitpid [] pid with
  | _, Unix.WEXITED 0 -> ()
  | _ -> Alcotest.fail "a writer process failed"

let test_concurrent_writers () =
  let root = fixture_copy () in
  let before = List.length (nonempty_lines (read_file (hosta_file root))) in
  let writers = 4 and per_writer = 15 and adds = 5 in
  let pids =
    List.init writers (fun w ->
        spawn (fun () ->
            (* Every writer starts the same id sequence: only the lock and the
               collision check keep the ids apart. *)
            let c = ctx ~seed:1 root in
            for i = 1 to per_writer do
              ignore (ok (Write_task.log c ~task:"4f5a" (Printf.sprintf "w%d-%d" w i)))
            done;
            for i = 1 to adds do
              ignore (ok (Write_task.add c ~title:(Printf.sprintf "task %d-%d" w i) ~product:"gateway" ()))
            done))
  in
  List.iter wait_ok pids;
  let lines = nonempty_lines (read_file (hosta_file root)) in
  Alcotest.(check int) "every line is there"
    (before + (writers * per_writer) + (writers * adds))
    (List.length lines);
  List.iter
    (fun l ->
      if Result.is_error (Event.classify l) && not (contains ~sub:"not json" l) then
        Alcotest.failf "torn or interleaved line: %s" l)
    lines;
  let loaded = load root in
  for w = 0 to writers - 1 do
    for i = 1 to per_writer do
      let text = Printf.sprintf "\"text\":\"w%d-%d\"" w i in
      if not (List.exists (contains ~sub:text) lines) then Alcotest.failf "lost %s" text
    done
  done;
  Alcotest.(check int) "distinct task ids" (8 + (writers * adds)) (Model.Smap.cardinal loaded.world.tasks);
  Alcotest.(check int) "one task file per task" (writers * adds)
    (List.length
       (List.filter (fun (p, _) -> contains ~sub:"-task-" p) (tree_snapshot (Filename.concat root "tasks"))))

let test_lock_timeout () =
  let root = fixture_copy () in
  let c = ctx ~lock_timeout:0.2 root in
  let before = tree_snapshot root in
  Lock.with_lock ~path:(Ctx.lock_path c) ~timeout:1.0 (fun () ->
      let started = Unix.gettimeofday () in
      check_error "lock held elsewhere" Err.Lock_timeout (Write_task.log c ~task:"4f5a" "blocked");
      Alcotest.(check bool) "waited for the timeout" true (Unix.gettimeofday () -. started >= 0.19));
  Alcotest.(check bool) "nothing written" true (before = tree_snapshot root);
  ignore (ok (Write_task.log c ~task:"4f5a" "after the lock is released"))

let test_flock_is_exclusive_across_descriptors () =
  (* The lock is a BSD flock, the one `wl` takes: a second open of the same file excludes. *)
  let path = Filename.concat (temp_dir "wllock") ".wl.lock" in
  Lock.with_lock ~path ~timeout:1.0 (fun () ->
      match Lock.with_lock ~path ~timeout:0.1 (fun () -> ()) with
      | () -> Alcotest.fail "the lock was taken twice"
      | exception Err.E e -> Alcotest.(check bool) "timeout" true (e.kind = Err.Lock_timeout))

(* ---- torn lines, durability ---------------------------------------------- *)

let test_torn_last_line () =
  let root = fixture_copy () in
  let path = hosta_file root in
  write_file path (read_file path ^ "{\"ts\":\"2026-11-10T11:00:00Z\",\"task\":\"T-4f5a\",\"ty");
  let c = ctx root in
  ignore (ok (Write_task.log c ~task:"4f5a" "after a crash"));
  let lines = nonempty_lines (read_file path) in
  let n = List.length lines in
  Alcotest.(check string) "the torn fragment keeps its own line" "{\"ts\":\"2026-11-10T11:00:00Z\",\"task\":\"T-4f5a\",\"ty"
    (List.nth lines (n - 2));
  Alcotest.(check bool) "the new event is intact" true
    (Result.is_ok (Event.classify (List.nth lines (n - 1))));
  let loaded = load root in
  Alcotest.(check bool) "fragment reported with file and line" true
    (has_warning ~sub:(Printf.sprintf "2026-11.hosta.jsonl:%d: skipped malformed line" (n - 1)) loaded.warnings);
  Alcotest.(check (option string)) "event applied" (Some "after a crash") (task_exn loaded.world "T-4f5a").last_note

let test_append_primitives () =
  let dir = temp_dir "wlappend" in
  let f = Filename.concat dir "sub/dir/a.jsonl" in
  Appendfile.append f "one\n";
  Appendfile.append f "two\n";
  Alcotest.(check string) "created, directories included; no stray newline" "one\ntwo\n" (read_file f);
  write_file f "no newline";
  Appendfile.append f "next\n";
  Alcotest.(check string) "missing newline written first" "no newline\nnext\n" (read_file f);
  Alcotest.(check bool) "missing file counts as clean" true
    (Appendfile.last_byte_is_newline (Filename.concat dir "nothing"));
  Alcotest.(check string) "tail" "xt\n" (Appendfile.tail f 3);
  let g = Filename.concat dir "new.md" in
  Appendfile.create_exclusive g "content";
  Alcotest.(check bool) "exclusive create never overwrites" true
    (match Appendfile.create_exclusive g "other" with
    | () -> false
    | exception Err.E _ -> true);
  Alcotest.(check string) "first content kept" "content" (read_file g)

let test_unencodable_text_writes_nothing () =
  let root = fixture_copy () in
  let c = ctx root in
  let before = tree_snapshot root in
  check_error "invalid UTF-8 text" Err.Usage (Write_task.log c ~task:"4f5a" "bad \xff bytes");
  check_error "invalid UTF-8 title" Err.Usage (Write_task.add c ~title:"bad \xff" ~product:"gateway" ());
  Alcotest.(check bool) "nothing written" true (before = tree_snapshot root)

(* ---- git ----------------------------------------------------------------- *)

let git_repo () =
  let root = temp_dir "wlgit" in
  ok (Init.init ~root ());
  root

let commit_count root = int_of_string (git root [ "rev-list"; "--count"; "HEAD" ])

let test_commit_scope () =
  let root = git_repo () in
  let c = ctx ~commit:true ~warn:(fun w -> Alcotest.failf "unexpected warning: %s" w) root in
  write_file (Filename.concat root "scratch.txt") "staged but unrelated\n";
  git root [ "add"; "scratch.txt" ] |> ignore;
  write_file (Filename.concat root ".gitignore") (read_file (Filename.concat root ".gitignore") ^ "# dirty\n");
  let id = ok (Write_task.add c ~title:"Committed task" ~product:"general" ()) in
  Alcotest.(check string) "message" ("wl: add " ^ id) (git root [ "log"; "-1"; "--format=%s" ]);
  Alcotest.(check (list string)) "only the written paths"
    (List.sort String.compare [ "events/2026-11.hosta.jsonl"; Printf.sprintf "tasks/general/%s-committed-task.md" id ])
    (List.sort String.compare (nonempty_lines (git root [ "show"; "--name-only"; "--format="; "HEAD" ])));
  let status = nonempty_lines (git root [ "status"; "--porcelain" ]) in
  Alcotest.(check bool) "unrelated staged and dirty files stay as they were" true
    (List.mem "A  scratch.txt" status && List.exists (contains ~sub:".gitignore") status);
  let n = commit_count root in
  ignore (ok (Write_task.set c ~task:id ~field:"status" ~value:(Some "in_progress") ()));
  Alcotest.(check string) "status message" ("wl: status " ^ id) (git root [ "log"; "-1"; "--format=%s" ]);
  ignore (ok (Write_task.set c ~task:id ~field:"status" ~value:(Some "in_progress") ()));
  Alcotest.(check int) "unchanged set: no commit" (n + 1) (commit_count root);
  ignore (ok (Write_task.log c ~task:id "a note"));
  Alcotest.(check string) "log message" ("wl: log " ^ id) (git root [ "log"; "-1"; "--format=%s" ]);
  let pid = ok (Write_project.add c ~title:"Committed project" ~product:"general" ()) in
  Alcotest.(check string) "project message" ("wl: project add " ^ pid) (git root [ "log"; "-1"; "--format=%s" ]);
  Alcotest.(check string) "no remote, nothing pushed" "" (git root [ "remote" ])

let test_commit_skipped () =
  let plain = fixture_copy () in
  let warnings = ref [] in
  let c = ctx ~commit:true ~warn:(fun w -> warnings := w :: !warnings) plain in
  ignore (ok (Write_task.log c ~task:"4f5a" "no git here"));
  Alcotest.(check bool) "not a git repository: data kept, one warning" true
    (has_warning ~sub:"not a git repository" !warnings
    && contains ~sub:"no git here" (read_file (hosta_file plain)));
  let root = git_repo () in
  warnings := [];
  let c = ctx ~commit:true ~warn:(fun w -> warnings := w :: !warnings) root in
  let n = commit_count root in
  write_file (Filename.concat root ".git/MERGE_HEAD") "0000000000000000000000000000000000000000\n";
  let id = ok (Write_task.add c ~title:"During a merge" ~product:"general" ()) in
  Alcotest.(check bool) "merge in progress: skipped with a warning, data written" true
    (has_warning ~sub:"merge is in progress" !warnings
    && commit_count root = n
    && contains ~sub:id (read_file (hosta_file root)));
  Sys.remove (Filename.concat root ".git/MERGE_HEAD")

(* ---- init ---------------------------------------------------------------- *)

let test_init () =
  let root = Filename.concat (temp_dir "wlinit") "fresh/repo" in
  ok (Init.init ~root ~category:"platform" ~category_name:"Platform" ~product:"gateway" ());
  Alcotest.(check string) "taxonomy"
    "categories:\n  platform:\n    name: Platform\n    products:\n      - gateway\n"
    (read_file (Filename.concat root "taxonomy.yaml"));
  Alcotest.(check bool) "empty tasks/ and events/" true
    (Sys.is_directory (Filename.concat root "tasks") && Sys.is_directory (Filename.concat root "events"));
  Alcotest.(check string) "one local commit" "wl: init" (git root [ "log"; "--format=%s" ]);
  Alcotest.(check string) "no remote" "" (git root [ "remote" ]);
  let tax = ok (Taxonomy.load (Filename.concat root "taxonomy.yaml")) in
  Alcotest.(check (list string)) "valid taxonomy" [ "gateway" ] (Taxonomy.products tax);
  Alcotest.(check int) "reads as an empty repository" 0 (Model.Smap.cardinal (load root).world.tasks);
  (* The repository found through the environment is usable at once. *)
  let getenv = function "WL_HOME" -> Some root | _ -> None in
  let c = ok (Ctx.of_env ~getenv ~commit:true ()) in
  let id = ok (Write_task.add c ~title:"First task" ~product:"gateway" ()) in
  Alcotest.(check bool) "first task listed" true
    (List.exists (fun (t : Model.task) -> t.id = id)
       (fst (ok (Reader.list_tasks c Query.no_filter))));
  let before = read_file (Filename.concat root "taxonomy.yaml") in
  check_error "refuses to overwrite" Err.Usage (Init.init ~root ~product:"other" ());
  Alcotest.(check string) "existing repository untouched" before (read_file (Filename.concat root "taxonomy.yaml"))

let test_init_inputs () =
  let dir () = Filename.concat (temp_dir "wlinit") "r" in
  check_error "bad product" Err.Usage (Init.init ~root:(dir ()) ~product:"a b" ());
  check_error "yaml-typed product" Err.Usage (Init.init ~root:(dir ()) ~product:"yes" ());
  check_error "bad category name" Err.Usage (Init.init ~root:(dir ()) ~category_name:"a: b" ());
  let no_git = dir () in
  ok (Init.init ~root:no_git ~git:false ());
  Alcotest.(check bool) "no git repository when not asked for" false (Sys.file_exists (Filename.concat no_git ".git"))

let () =
  Alcotest.run "worklog files"
    [ ( "concurrency",
        [ Alcotest.test_case "four writer processes" `Quick test_concurrent_writers;
          Alcotest.test_case "lock timeout" `Quick test_lock_timeout;
          Alcotest.test_case "flock excludes across descriptors" `Quick test_flock_is_exclusive_across_descriptors ] );
      ( "durability",
        [ Alcotest.test_case "torn last line" `Quick test_torn_last_line;
          Alcotest.test_case "append primitives" `Quick test_append_primitives;
          Alcotest.test_case "unencodable text" `Quick test_unencodable_text_writes_nothing ] );
      ( "git",
        [ Alcotest.test_case "commit scope and messages" `Quick test_commit_scope;
          Alcotest.test_case "commit skipped" `Quick test_commit_skipped ] );
      ( "init",
        [ Alcotest.test_case "layout and refusal" `Quick test_init;
          Alcotest.test_case "inputs" `Quick test_init_inputs ] ) ]
