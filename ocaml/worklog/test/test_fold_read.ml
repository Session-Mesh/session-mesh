(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Reading the fictional fixture: fold, ordering, warnings, derived reads. *)

open Mesh_worklog
open Tutil

let ids tasks = List.map (fun (t : Model.task) -> t.id) tasks
let strings = Alcotest.(list string)

(* Events from raw lines, as if read from one file of one host. *)
let events_of ?(host = "hosta") ?(file = "2026-11.hosta.jsonl") lines =
  List.mapi
    (fun i raw ->
      match Event.classify raw with
      | Error why -> Alcotest.failf "bad test line %d: %s" (i + 1) why
      | Ok (data, ts) ->
          let get k = match List.assoc_opt k data with Some (`String s) -> s | _ -> "" in
          { Event.ts; task = get "task"; typ = get "type"; data; host; file; line = i + 1 })
    lines

let fold lines =
  let warnings = ref [] in
  let world = Fold.fold (events_of lines) (fun w -> warnings := w :: !warnings) in
  (world, List.rev !warnings)

let line ?(task = "T-aaaa") ts typ rest =
  Printf.sprintf "{\"ts\":\"%s\",\"task\":\"%s\",\"type\":\"%s\"%s}" ts task typ
    (if rest = "" then "" else "," ^ rest)

let created ?(task = "T-aaaa") ?(title = "A task") ?(status = "todo") ts =
  line ~task ts "created"
    (Printf.sprintf
       "\"title\":\"%s\",\"project\":\"gateway\",\"category\":\"platform\",\"priority\":\"P2\",\"status\":\"%s\""
       title status)

let set ?(task = "T-aaaa") ts field to_ =
  line ~task ts "set" (Printf.sprintf "\"field\":\"%s\",\"to\":%s" field to_)

(* ---- the fixture ------------------------------------------------------- *)

let test_fixture_state () =
  let loaded = load fixture_dir in
  let w = loaded.world in
  Alcotest.(check strings) "task ids"
    [ "T-1a2b"; "T-2d3e"; "T-3c4d"; "T-4f5a"; "T-6b7c"; "T-7a8b"; "T-8d9e"; "T-9c0d" ]
    (List.map fst (Model.Smap.bindings w.tasks));
  let t = task_exn w "T-1a2b" in
  Alcotest.(check string) "priority: later host wins the tie" "P0" t.priority;
  Alcotest.(check string) "status from the older file" "in_progress" t.status;
  Alcotest.(check (option string)) "project" (Some "P-5e6f") t.project_id;
  Alcotest.(check string) "owner" "ana" t.owner;
  Alcotest.(check (option string)) "size" (Some "M") t.size;
  Alcotest.(check (option string)) "eta" (Some "2026-11-20") t.eta;
  Alcotest.(check (option string)) "origin" (Some "planned") t.origin;
  Alcotest.(check (option string)) "track" (Some "first run") t.track;
  Alcotest.(check strings) "also" [ "relay-core" ] t.also;
  Alcotest.(check (option string)) "last_note is the latest progress; kinds do not change it" (Some "extra field") t.last_note;
  Alcotest.(check int) "timeline: unknown type and malformed line left out" 22
    (List.length t.timeline);
  Alcotest.(check (option int)) "last_ts" (Some (ts "2026-11-06T11:00:00Z")) t.last_ts;
  (match t.blockers with
  | [ b ] ->
      Alcotest.(check (option int)) "blocker resolved" (Some (ts "2026-11-06T11:00:00Z")) b.resolved
  | _ -> Alcotest.fail "one blocker expected");
  let moved = task_exn w "T-3c4d" in
  Alcotest.(check (pair string string)) "reclassified: current product" ("relay-edge", "platform")
    (moved.product, moved.category);
  Alcotest.(check string) "home product kept" "relay-core" moved.home_product;
  Alcotest.(check int) "one session link" 1 (List.length moved.sessions);
  Alcotest.(check int) "one open blocker" 1
    (List.length (List.filter (fun (b : Model.blocker) -> b.resolved = None) moved.blockers));
  let p = project_exn w "P-5e6f" in
  Alcotest.(check (pair string (option string))) "project" ("Delivery rollout", Some "2026Q4")
    (p.title_p, p.quarter);
  Alcotest.(check strings) "milestones" [ "pilot run" ] p.milestones

let test_fixture_warnings () =
  let ws = (load fixture_dir).warnings in
  Alcotest.(check bool) "malformed line with file and line" true
    (has_warning ~sub:"2026-11.hosta.jsonl:15: skipped malformed line (invalid JSON)" ws);
  Alcotest.(check bool) "unknown type" true
    (has_warning ~sub:"ignoring unknown event type \"forecast\"" ws);
  Alcotest.(check bool) "unknown field" true (has_warning ~sub:"unknown field \"mood\"" ws);
  Alcotest.(check bool) "duplicate id" true (has_warning ~sub:"DUPLICATE_ID T-7a8b" ws);
  Alcotest.(check bool) "orphan task file" true (has_warning ~sub:"T-ffff" ws);
  Alcotest.(check int) "nothing else" 5 (List.length ws)

let test_duplicates () =
  let w = (load fixture_dir).world in
  let t = task_exn w "T-7a8b" in
  Alcotest.(check string) "earliest created wins" "Label the pallets" t.title;
  Alcotest.(check string) "its priority" "P2" t.priority;
  Alcotest.(check int) "identical lines in two files count once; loser not in timeline" 2
    (List.length t.timeline);
  let events, _ = Store.read_events (ctx fixture_dir) in
  let repeats =
    List.filter
      (fun (e : Event.t) -> e.typ = "progress" && Event.get_string e "text" = Some "van loaded")
      events
  in
  Alcotest.(check int) "repeats inside one file are kept" 2 (List.length repeats)

(* ---- determinism and ordering ------------------------------------------ *)

let shuffle seed l =
  let rng = Random.State.make [| seed |] in
  List.map snd (List.sort compare (List.map (fun x -> (Random.State.bits rng, x)) l))

let test_fold_order_independent () =
  let events, _ = Store.read_events (ctx fixture_dir) in
  let run evs =
    let ws = ref [] in
    let w = Fold.fold evs (fun m -> ws := m :: !ws) in
    (dump_world w, List.rev !ws)
  in
  let reference = run events in
  List.iter
    (fun seed ->
      let dump, ws = run (shuffle seed events) in
      Alcotest.(check string) (Printf.sprintf "state, shuffle %d" seed) (fst reference) dump;
      Alcotest.(check (list string)) (Printf.sprintf "warnings, shuffle %d" seed) (snd reference) ws)
    [ 1; 2; 3; 4; 5 ]

let test_order_rules () =
  let w, _ =
    fold
      [ created "2026-11-01T10:00:00Z";
        set "2026-11-01T11:00:00Z" "status" "\"done\"";
        set "2026-11-01T11:00:00Z" "status" "\"waiting\"" ]
  in
  Alcotest.(check string) "same host, same second: later line wins" "waiting"
    (task_exn w "T-aaaa").status;
  let w, _ =
    fold [ set "2026-11-01T09:00:00Z" "status" "\"done\""; created "2026-11-01T10:00:00Z" ]
  in
  Alcotest.(check string) "created is the initial value at its own key" "todo"
    (task_exn w "T-aaaa").status;
  (* Hosts: the larger host name wins a tie, whatever the file order. *)
  let a =
    events_of ~host:"hosta" ~file:"2026-11.hosta.jsonl"
      [ created "2026-11-01T10:00:00Z"; set "2026-11-01T11:00:00Z" "priority" "\"P3\"" ]
  in
  let b =
    events_of ~host:"hostb" ~file:"2026-11.hostb.jsonl"
      [ set "2026-11-01T11:00:00Z" "priority" "\"P0\"" ]
  in
  List.iter
    (fun evs ->
      Alcotest.(check string) "host tie-break" "P0" (task_exn (Fold.fold evs ignore) "T-aaaa").priority)
    [ a @ b; b @ a ]

let test_fold_validation () =
  let w, ws =
    fold
      [ created "2026-11-01T10:00:00Z";
        set "2026-11-01T10:01:00Z" "status" "\"bogus\"";
        set "2026-11-01T10:02:00Z" "status" "null";
        set "2026-11-01T10:03:00Z" "colour" "\"red\"";
        set "2026-11-01T10:04:00Z" "product" "\"relay\"";
        line "2026-11-01T10:05:00Z" "progress" "\"text\":\"x\",\"prov\":\"bogus\"";
        line "2026-11-01T10:06:00Z" "shipped" "\"text\":\"released\"";
        line "2026-11-01T10:07:00Z" "blocker" "\"id\":\"B-aa01\",\"kind\":\"weird\",\"text\":\"t\"";
        line "2026-11-01T10:08:00Z" "unblocked" "\"blocker\":\"B-nope\"";
        line ~task:"T-bbbb" "2026-11-01T10:09:00Z" "progress" "\"text\":\"orphan\"";
        line ~task:"P-aaaa" "2026-11-01T10:10:00Z" "progress" "\"text\":\"on a project\"";
        line "2026-11-01T10:11:00Z" "project_created"
          "\"title\":\"t\",\"product\":\"p\",\"category\":\"c\"" ]
  in
  let t = task_exn w "T-aaaa" in
  Alcotest.(check string) "status untouched by invalid sets" "todo" t.status;
  Alcotest.(check string) "invalid prov: event still applied" "x" (Option.get t.last_note);
  Alcotest.(check int) "events of known types stay in the timeline when their value is refused, an invalid kind payload does not" 8
    (List.length t.timeline);
  List.iter
    (fun sub -> Alcotest.(check bool) sub true (has_warning ~sub ws))
    [ "ignoring set status"; "unregistered field \"colour\""; "set product: product needs a category";
      "invalid prov \"bogus\""; "ignoring shipped"; "bad kind weird"; "unknown blocker B-nope";
      "event for unknown task T-bbbb"; "event for unknown project P-aaaa";
      "project_created on task id T-aaaa" ]

let test_project_before_creation () =
  let w, ws =
    fold [ created "2026-11-01T10:00:00Z"; set "2026-11-01T10:01:00Z" "project" "\"P-cafe\"" ]
  in
  Alcotest.(check (option string)) "raw project id kept" (Some "P-cafe")
    (task_exn w "T-aaaa").project_id;
  Alcotest.(check strings) "no warning from the fold itself" [] ws

(* ---- reads --------------------------------------------------------------- *)

let test_read_edge_cases () =
  Alcotest.(check bool) "file names" true
    (Store.parse_event_file_name "2026-11.host-a.jsonl" = Some ("2026-11", "host-a")
    && Store.parse_event_file_name "2026-11.Host.jsonl" = None
    && Store.parse_event_file_name "notes.jsonl" = None);
  let root = fixture_copy () in
  write_file (Filename.concat root "events/stray.jsonl") "{}\n";
  write_file
    (Filename.concat root "events/2026-12.hostc.jsonl")
    (line ~task:"T-1a2b" "2026-12-20T00:00:00Z" "note" "\"text\":\"far ahead\"" ^ "\n");
  write_file
    (Filename.concat root "events/2026-11.hostd.jsonl")
    (line ~task:"T-1a2b" "2026-11-10T13:00:00Z" "note" "\"text\":\"no final newline\"");
  let loaded = load root in
  Alcotest.(check bool) "unexpected file name" true
    (has_warning ~sub:"unexpected name: stray.jsonl" loaded.warnings);
  Alcotest.(check bool) "future timestamp accepted with a warning" true
    (has_warning ~sub:"2026-12.hostc.jsonl:1: ts is more than 1 day in the future" loaded.warnings);
  Alcotest.(check (option string)) "last line without newline is read" (Some "far ahead")
    (task_exn loaded.world "T-1a2b").last_note;
  Alcotest.(check bool) "strict scan lists malformed lines" true
    (List.exists
       (contains ~sub:"2026-11.hosta.jsonl:15: invalid JSON")
       (Store.scan_malformed (ctx root)));
  let empty = temp_dir "wlempty" in
  write_file
    (Filename.concat empty "taxonomy.yaml")
    "categories:\n  a:\n    name: A\n    projects: [p]\n";
  Alcotest.(check int) "repository without events/ or tasks/" 0
    (Model.Smap.cardinal (load empty).world.tasks)

(* ---- queries ------------------------------------------------------------ *)

let snapshot () = ok (Reader.snapshot (ctx fixture_dir))
let list ?taxonomy f = ok (Query.list_tasks (snapshot ()).loaded.world ?taxonomy f)

let test_list_tasks () =
  let s = snapshot () in
  let tax = Option.get s.taxonomy in
  Alcotest.(check strings) "default hides done and dropped, ordered by priority then id"
    [ "T-1a2b"; "T-3c4d"; "T-8d9e"; "T-2d3e"; "T-4f5a"; "T-6b7c"; "T-7a8b" ]
    (ids (list Query.no_filter));
  Alcotest.(check strings) "closed too" [ "T-9c0d" ]
    (ids (list { Query.no_filter with status = [ "done" ] }));
  Alcotest.(check int) "include closed" 8
    (List.length (list { Query.no_filter with include_closed = true }));
  Alcotest.(check strings) "product roll-up" [ "T-3c4d"; "T-2d3e"; "T-6b7c" ]
    (ids (list ~taxonomy:tax { Query.no_filter with product = Some "relay" }));
  Alcotest.(check strings) "without taxonomy: exact match" []
    (ids (list { Query.no_filter with product = Some "relay" }));
  Alcotest.(check strings) "current product, not home" [ "T-3c4d"; "T-6b7c" ]
    (ids (list { Query.no_filter with product = Some "relay-edge" }));
  Alcotest.(check strings) "project by prefix" [ "T-1a2b"; "T-3c4d" ]
    (ids (list { Query.no_filter with project = Some "5e" }));
  Alcotest.(check strings) "owner" [ "T-1a2b" ]
    (ids (list { Query.no_filter with owner = Some "ana" }));
  Alcotest.(check strings) "track" [ "T-1a2b" ]
    (ids (list { Query.no_filter with track = Some "first run" }));
  Alcotest.(check strings) "session" [ "T-3c4d" ]
    (ids (list { Query.no_filter with session = Some "s-old" }));
  Alcotest.(check strings) "category" [ "T-9c0d" ]
    (ids (list { Query.no_filter with category = Some "office"; include_closed = true }));
  check_error "unknown project" Err.Not_found
    (Query.list_tasks (snapshot ()).loaded.world { Query.no_filter with project = Some "dead" })

let test_get_task () =
  let ctx = ctx fixture_dir in
  let w = (Store.load ctx).world in
  let v = ok (Query.get_task ctx w "1a2b") in
  Alcotest.(check string) "notes" "Context: the first pallet goes by road.\nNext step: confirm the van."
    v.notes;
  Alcotest.(check (option string)) "project title" (Some "Delivery rollout") v.project_title;
  Alcotest.(check int) "timeline" 22 (List.length v.task.timeline);
  Alcotest.(check int) "no open blocker" 0 (List.length v.open_blockers);
  let v = ok (Query.get_task ctx w "t-3c4d") in
  Alcotest.(check int) "open blocker" 1 (List.length v.open_blockers);
  Alcotest.(check bool) "file disagrees with the events: warning, event wins" true
    (has_warning ~sub:"project mismatch" v.warnings);
  Alcotest.(check string) "event wins" "relay-edge" v.task.product;
  check_error "unknown" Err.Not_found (Query.get_task ctx w "beef");
  check_error "malformed" Err.Usage (Query.get_task ctx w "xyz");
  check_error "project id is not a task" Err.Not_found (Query.get_task ctx w "P-5e6f")

let test_refs () =
  let w, _ =
    fold
      [ created ~task:"T-ab12" "2026-11-01T10:00:00Z";
        created ~task:"T-ab123" "2026-11-01T10:00:00Z";
        created ~task:"T-cd34" "2026-11-01T10:00:00Z";
        line ~task:"P-ab12" "2026-11-01T10:00:00Z" "project_created"
          "\"title\":\"p\",\"product\":\"x\",\"category\":\"c\"" ]
  in
  Alcotest.(check string) "exact beats prefix" "T-ab12" (ok (Refs.task w "ab12"));
  Alcotest.(check string) "case and prefix" "T-cd34" (ok (Refs.task w "T-CD"));
  check_error "ambiguous prefix" Err.Not_found (Refs.task w "ab");
  check_error "too short" Err.Usage (Refs.task w "a");
  check_error "task ref on a project id" Err.Not_found (Refs.task w "p-ab12");
  check_error "project ref on a task id" Err.Not_found (Refs.project w "t-ab12");
  Alcotest.(check string) "project namespace is separate" "P-ab12" (ok (Refs.project w "ab12"))

let test_projects () =
  let s = snapshot () in
  (match Query.list_projects s.loaded.world () with
  | [ r ] ->
      Alcotest.(check (list int)) "counts" [ 2; 0 ] [ r.open_tasks; r.done_tasks ];
      Alcotest.(check (option (float 0.001))) "progress" (Some 0.0) r.progress;
      Alcotest.(check strings) "spans two products" [ "T-1a2b"; "T-3c4d" ]
        (ids (Query.tasks_of_project s.loaded.world "P-5e6f"))
  | _ -> Alcotest.fail "one project expected");
  Alcotest.(check int) "product roll-up" 1
    (List.length (Query.list_projects s.loaded.world ?taxonomy:s.taxonomy ~product:"relay" ()));
  Alcotest.(check int) "other quarter" 0
    (List.length (Query.list_projects s.loaded.world ~quarter:"2027Q1" ()));
  let task n = created ~task:(Printf.sprintf "T-000%d" n) "2026-11-01T10:00:00Z" in
  let join n = set ~task:(Printf.sprintf "T-000%d" n) "2026-11-01T10:01:00Z" "project" "\"P-0001\"" in
  let w, _ =
    fold
      ([ line ~task:"P-0001" "2026-11-01T10:00:00Z" "project_created"
           "\"title\":\"p\",\"product\":\"x\",\"category\":\"c\"" ]
      @ List.map task [ 1; 2; 3; 4 ] @ List.map join [ 1; 2; 3; 4 ]
      @ [ set ~task:"T-0001" "2026-11-01T10:02:00Z" "status" "\"done\"";
          set ~task:"T-0002" "2026-11-01T10:02:00Z" "status" "\"dropped\"";
          set ~task:"P-0001" "2026-11-01T10:03:00Z" "status" "\"done\"" ])
  in
  Alcotest.(check int) "done project hidden by default" 0 (List.length (Query.list_projects w ()));
  match Query.list_projects w ~include_closed:true () with
  | [ r ] ->
      Alcotest.(check (list int)) "open, done (dropped counts in neither)" [ 2; 1 ]
        [ r.open_tasks; r.done_tasks ];
      Alcotest.(check (option (float 0.001))) "done over open plus done" (Some (1.0 /. 3.0))
        r.progress
  | _ -> Alcotest.fail "one project expected"

(* ---- resume ------------------------------------------------------------- *)

let where =
  { Resume.host = "hosta"; cwd = "/work/relay/sub"; home = Some "/srv/x"; session = Some "s-here";
    repo = None; branch = None }

let rows l = List.map (fun (r : Resume.row) -> r.task.id) l

let test_resume_sections () =
  let w = (snapshot ()).loaded.world in
  let r = Resume.build w ~now:fixture_now ~where () in
  Alcotest.(check strings) "HERE: session first, then folder ancestor" [ "T-6b7c"; "T-3c4d" ]
    (rows r.here);
  Alcotest.(check (list (option int))) "tiers" [ Some 1; Some 3 ]
    (List.map (fun (x : Resume.row) -> x.tier) r.here);
  Alcotest.(check strings) "BLOCKED/WAITING" [ "T-8d9e" ] (rows r.blocked);
  Alcotest.(check (list bool)) "unblock? when every dependency is done" [ true ]
    (List.map (fun (x : Resume.row) -> x.unblock) r.blocked);
  Alcotest.(check strings) "IN PROGRESS" [ "T-1a2b" ] (rows r.in_progress);
  Alcotest.(check strings) "STALE" [ "T-4f5a" ] (rows r.stale);
  Alcotest.(check strings) "DUE" [ "T-2d3e" ] (rows r.due);
  Alcotest.(check strings) "TODO hidden by default" [] (rows r.todo);
  let all = List.concat_map rows [ r.here; r.in_progress; r.blocked; r.stale; r.due; r.todo ] in
  Alcotest.(check int) "each task once" (List.length all)
    (List.length (List.sort_uniq compare all));
  (match r.in_progress with
  | [ x ] ->
      Alcotest.(check int) "days since the last event" 4 x.days;
      Alcotest.(check (option string)) "last note" (Some "extra field") x.last_note;
      Alcotest.(check (option string)) "project title" (Some "Delivery rollout") x.project_title
  | _ -> Alcotest.fail "one in-progress task expected");
  Alcotest.(check (list int)) "stale days" [ 9 ] (List.map (fun (x : Resume.row) -> x.days) r.stale);
  let r = Resume.build w ~now:fixture_now ~show_all:true () in
  Alcotest.(check strings) "TODO with show_all" [ "T-7a8b" ] (rows r.todo)

let test_resume_precedence_and_options () =
  let w = (snapshot ()).loaded.world in
  let r = Resume.build w ~now:fixture_now () in
  Alcotest.(check strings) "no where: no HERE" [] (rows r.here);
  Alcotest.(check strings) "blocked task is back in BLOCKED, ordered by product when structured"
    [ "T-8d9e"; "T-3c4d" ] (rows r.blocked);
  Alcotest.(check strings) "in progress" [ "T-1a2b"; "T-6b7c" ] (rows r.in_progress);
  Alcotest.(check strings) "stale threshold is strict and configurable" [ "T-4f5a" ]
    (rows (Resume.build w ~now:fixture_now ~stale_days:8 ()).stale);
  Alcotest.(check strings) "nothing stale at 10 days" []
    (rows (Resume.build w ~now:fixture_now ~stale_days:10 ()).stale);
  Alcotest.(check strings) "due window ends 7 days out" [ "T-2d3e" ]
    (rows (Resume.build w ~now:(ts "2026-11-05T12:00:00Z") ()).due);
  Alcotest.(check strings) "not yet due" []
    (rows (Resume.build w ~now:(ts "2026-11-04T12:00:00Z") ()).due);
  let keep (t : Model.task) = t.product = "gateway" in
  Alcotest.(check strings) "keep filter" [ "T-1a2b" ]
    (rows (Resume.build w ~now:fixture_now ~keep ()).in_progress);
  let elsewhere =
    Resume.build w ~now:fixture_now ~where:{ where with session = None; cwd = "/elsewhere" } ()
  in
  Alcotest.(check strings) "other folder: no HERE" [] (rows elsewhere.here)

let test_resume_here_rules () =
  let link ~task ~session ~cwd ?(host = "hosta") ?repo ?branch ts =
    let j = function Some s -> Printf.sprintf "\"%s\"" s | None -> "null" in
    line ~task ts "session_linked"
      (Printf.sprintf
         "\"agent\":\"claude\",\"session\":\"%s\",\"cwd\":\"%s\",\"host\":\"%s\",\"repo\":%s,\"branch\":%s"
         session cwd host (j repo) (j branch))
  in
  let tasks = List.init 7 (fun i -> Printf.sprintf "T-000%d" (i + 1)) in
  let w, _ =
    fold
      (List.map (fun t -> created ~task:t "2026-11-01T10:00:00Z") tasks
      @ List.mapi
          (fun i t ->
            link ~task:t ~session:(Printf.sprintf "s%d" i) ~cwd:"/work"
              (Printf.sprintf "2026-11-02T10:0%d:00Z" i))
          tasks)
  in
  let here_at w' = { w' with Resume.cwd = "/work/x"; session = None } in
  let r = Resume.build w ~now:fixture_now ~where:(here_at where) () in
  Alcotest.(check int) "HERE capped at 5" 5 (List.length r.here);
  Alcotest.(check strings) "most recently linked first"
    [ "T-0007"; "T-0006"; "T-0005"; "T-0004"; "T-0003" ] (rows r.here);
  Alcotest.(check strings) "overflow falls to its other section" [ "T-0001"; "T-0002" ]
    (rows (Resume.build w ~now:fixture_now ~where:(here_at where) ~show_all:true ()).todo);
  let home =
    Resume.build w ~now:fixture_now ~where:{ (here_at where) with home = Some "/work" } ()
  in
  Alcotest.(check int) "linked folder equal to the home directory never matches" 0
    (List.length home.here);
  let other_host =
    Resume.build w ~now:fixture_now ~where:{ (here_at where) with host = "hostz" } ()
  in
  Alcotest.(check int) "other host never matches by folder" 0 (List.length other_host.here);
  let w2, _ =
    fold
      [ created "2026-11-01T10:00:00Z";
        link ~task:"T-aaaa" ~session:"s" ~cwd:"/elsewhere" ~repo:"/r" ~branch:"feat"
          "2026-11-02T10:00:00Z" ]
  in
  let at repo branch = { where with cwd = "/x"; session = None; repo = Some repo; branch = Some branch } in
  let by_branch = Resume.build w2 ~now:fixture_now ~where:(at "/r" "feat") () in
  Alcotest.(check (list (option int))) "same repo and branch is tier 2" [ Some 2 ]
    (List.map (fun (x : Resume.row) -> x.tier) by_branch.here);
  let other_branch = Resume.build w2 ~now:fixture_now ~where:(at "/r" "main") () in
  Alcotest.(check int) "other branch does not match" 0 (List.length other_branch.here)

let () =
  Alcotest.run "worklog fold and reads"
    [ ( "fixture",
        [ Alcotest.test_case "folded state" `Quick test_fixture_state;
          Alcotest.test_case "warnings" `Quick test_fixture_warnings;
          Alcotest.test_case "duplicates" `Quick test_duplicates;
          Alcotest.test_case "read edge cases" `Quick test_read_edge_cases ] );
      ( "fold",
        [ Alcotest.test_case "order independent" `Quick test_fold_order_independent;
          Alcotest.test_case "ordering rules" `Quick test_order_rules;
          Alcotest.test_case "validation" `Quick test_fold_validation;
          Alcotest.test_case "project reference before creation" `Quick test_project_before_creation ] );
      ( "queries",
        [ Alcotest.test_case "list_tasks" `Quick test_list_tasks;
          Alcotest.test_case "get_task" `Quick test_get_task;
          Alcotest.test_case "references" `Quick test_refs;
          Alcotest.test_case "projects" `Quick test_projects ] );
      ( "resume",
        [ Alcotest.test_case "sections" `Quick test_resume_sections;
          Alcotest.test_case "precedence and options" `Quick test_resume_precedence_and_options;
          Alcotest.test_case "HERE rules" `Quick test_resume_here_rules ] ) ]
