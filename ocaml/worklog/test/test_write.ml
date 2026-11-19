(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The writer: validations, events written, round trips. *)

open Mesh_worklog
open Tutil

let strings = Alcotest.(list string)

(* A fresh copy of the fixture, and its context. *)
let setup ?now () =
  let root = fixture_copy () in
  (root, ctx ?now root)

let world root = (load root).world
(* The newest line of the file this host (hosta) writes in November. *)
let last_line root =
  let lines = String.split_on_char (Char.chr 10) (read_file (Filename.concat root "events/2026-11.hosta.jsonl")) in
  List.nth (List.filter (fun l -> l <> "") lines) (List.length (List.filter (fun l -> l <> "") lines) - 1)

let unchanged_by root f =
  let before = tree_snapshot root in
  f ();
  Alcotest.(check bool) "nothing written" true (before = tree_snapshot root)

(* ---- add --------------------------------------------------------------- *)

let test_add_minimal () =
  let root, c = setup () in
  let id = ok (Write_task.add c ~title:"  Ship the second delivery " ~product:"gateway" ()) in
  Alcotest.(check bool) "id shape" true (Fields.valid_task_id id);
  Alcotest.(check string) "created event, defaults recorded explicitly"
    (Printf.sprintf
       "{\"ts\":\"2026-11-10T12:00:00Z\",\"task\":\"%s\",\"type\":\"created\",\"title\":\"Ship the second delivery\",\"project\":\"gateway\",\"category\":\"platform\",\"priority\":\"P2\",\"status\":\"todo\"}"
       id)
    (last_line root);
  let path =
    Filename.concat root (Printf.sprintf "tasks/gateway/%s-ship-the-second-delivery.md" id)
  in
  Alcotest.(check string) "task file: identity only"
    (Printf.sprintf
       "---\nid: %s\nproject: gateway\ncategory: platform\ncreated: \"2026-11-10T12:00:00Z\"\n---\n" id)
    (read_file path);
  let t = task_exn (world root) id in
  Alcotest.(check (pair string string)) "folded" ("todo", "P2") (t.status, t.priority)

let test_add_full () =
  let root, c = setup () in
  let id =
    ok
      (Write_task.add c ~session:(session ~cwd:"/w" ()) ~title:"R\xc3\xa9parer caf\xc3\xa9"
         ~product:"relay-core" ~priority:"P0" ~status:"in_progress" ~due:"2026-12-01"
         ~tags:[ "urgent"; "road" ] ~links:[ "https://example.test/x" ] ~project:"5e6f"
         ~track:" dock plan " ~owner:"ana" ~eta:"2026-12-05" ~size:"L" ~origin:"reactive"
         ~also:[ "gateway"; "gateway" ] ~notes:"First line.\nSecond line.\n" ())
  in
  let events = List.filter (contains ~sub:id) (event_lines root) in
  let kinds =
    List.map
      (fun l ->
        match Event.classify l with
        | Ok (f, _) ->
            let g k = match List.assoc_opt k f with Some (`String s) -> s | _ -> "" in
            g "type" ^ ":" ^ g "field" ^ ":" ^ g "to" ^ g "value"
        | Error w -> w)
      events
  in
  Alcotest.(check strings) "events in order"
    [ "created::"; "set:due:2026-12-01"; "set:project:P-5e6f"; "set:track:dock plan";
      "set:owner:ana"; "set:eta:2026-12-05"; "set:size:L"; "set:origin:reactive"; "add:tags:urgent";
      "add:tags:road"; "add:links:https://example.test/x"; "add:also:gateway" ]
    kinds;
  Alcotest.(check bool) "agent and session on every event" true
    (List.for_all (contains ~sub:"\"agent\":\"claude\",\"session\":\"s-test\"") events);
  let file = Filename.concat root (Printf.sprintf "tasks/relay-core/%s-reparer-cafe.md" id) in
  Alcotest.(check string) "notes after the frontmatter"
    (Printf.sprintf
       "---\nid: %s\nproject: relay-core\ncategory: platform\ncreated: \"2026-11-10T12:00:00Z\"\n---\nFirst line.\nSecond line.\n"
       id)
    (read_file file);
  let t = task_exn (world root) id in
  Alcotest.(check (list string)) "folded fields"
    [ "in_progress"; "P0"; "ana"; "L"; "reactive"; "dock plan" ]
    [ t.status; t.priority; t.owner; Option.get t.size; Option.get t.origin; Option.get t.track ];
  Alcotest.(check (list string)) "tags sorted, also deduplicated" [ "road"; "urgent"; "gateway" ]
    (t.tags @ t.also);
  let empty_slug = ok (Write_task.add c ~title:"???" ~product:"gateway" ()) in
  Alcotest.(check bool) "empty slug: file named by id alone" true
    (Sys.file_exists (Filename.concat root (Printf.sprintf "tasks/gateway/%s.md" empty_slug)))

let test_add_validation () =
  let root, c = setup () in
  let add ?(title = "Fine") ?(product = "gateway") ?priority ?status ?due ?size ?project ?also
      ?tags ?notes () =
    Write_task.add c ~title ~product ?priority ?status ?due ?size ?project ?also ?tags ?notes ()
  in
  unchanged_by root (fun () ->
      List.iter
        (fun (name, kind, r) -> check_error name kind r)
        [ ("empty title", Err.Usage, add ~title:"   " ());
          ("title with a newline", Err.Usage, add ~title:"a\nb" ());
          ("title too long", Err.Usage, add ~title:(String.make 201 'x') ());
          ("bad priority", Err.Usage, add ~priority:"P9" ());
          ("bad status", Err.Usage, add ~status:"bogus" ());
          ("bad due", Err.Usage, add ~due:"2026-02-30" ());
          ("bad size", Err.Usage, add ~size:"XL" ());
          ("unknown product", Err.Usage, add ~product:"nosuch" ());
          ("unknown also", Err.Usage, add ~also:[ "nosuch" ] ());
          ("blank tag", Err.Usage, add ~tags:[ " " ] ());
          ("unknown project", Err.Not_found, add ~project:"dead" ());
          ("NUL in notes", Err.Usage, add ~notes:"a\000b" ()) ])

let test_add_id_collision () =
  let root, c = setup () in
  let first = Ids.task (Random.State.make [| 7 |]) ~taken:[] in
  write_file (Filename.concat root (Printf.sprintf "tasks/gateway/%s-taken.md" first)) "---\n---\n";
  let id = ok (Write_task.add c ~title:"Redraw" ~product:"gateway" ()) in
  Alcotest.(check bool) "redrawn when a task file has the id" true (id <> first);
  let root2, _ = setup () in
  let c2 = ctx root2 in
  let again = Ids.task (Random.State.make [| 7 |]) ~taken:[] in
  write_file
    (Filename.concat root2 "events/2026-11.hostb.jsonl")
    (Printf.sprintf
       "{\"ts\":\"2026-11-01T00:00:00Z\",\"task\":\"%s\",\"type\":\"created\",\"title\":\"x\",\"project\":\"gateway\",\"category\":\"platform\",\"priority\":\"P2\",\"status\":\"todo\"}\n"
       again);
  let id2 = ok (Write_task.add c2 ~title:"Redraw" ~product:"gateway" ()) in
  Alcotest.(check bool) "redrawn when a created event of any host has the id" true (id2 <> again)

(* ---- set ---------------------------------------------------------------- *)

let test_set () =
  let root, c = setup () in
  let set ?session task field value = Write_task.set c ?session ~task ~field ~value () in
  let id, outcome = ok (set "4f5a" "status" (Some "waiting")) in
  Alcotest.(check bool) "changed" true (outcome = Write_task.Changed);
  Alcotest.(check string) "id returned in full" "T-4f5a" id;
  Alcotest.(check string) "event"
    "{\"ts\":\"2026-11-10T12:00:00Z\",\"task\":\"T-4f5a\",\"type\":\"set\",\"field\":\"status\",\"to\":\"waiting\"}"
    (last_line root);
  unchanged_by root (fun () ->
      Alcotest.(check bool) "same value writes nothing" true
        (ok (set "4f5a" "status" (Some "waiting")) = ("T-4f5a", Write_task.Unchanged));
      List.iter
        (fun (name, kind, r) -> check_error name kind r)
        [ ("bad status", Err.Usage, set "4f5a" "status" (Some "bogus"));
          ("title cannot be cleared", Err.Usage, set "4f5a" "title" None);
          ("status cannot be cleared", Err.Usage, set "4f5a" "status" None);
          ("unknown field", Err.Usage, set "4f5a" "colour" (Some "red"));
          ("bad size", Err.Usage, set "4f5a" "size" (Some "XL"));
          ("unknown product", Err.Usage, set "4f5a" "product" (Some "nosuch"));
          ("unknown project", Err.Not_found, set "4f5a" "project" (Some "dead"));
          ("unknown task", Err.Not_found, set "beef" "status" (Some "done")) ]);
  ignore (ok (set "4f5a" "product" (Some "relay-core")));
  Alcotest.(check bool) "product event carries the category" true
    (contains ~sub:"\"field\":\"product\",\"to\":\"relay-core\",\"category\":\"platform\""
       (last_line root));
  ignore (ok (set "4f5a" "project" (Some "P-5e6f")));
  ignore (ok (set "4f5a" "due" (Some "2026-12-01")));
  ignore (ok (set "4f5a" "due" None));
  ignore (ok (set "4f5a" "owner" (Some "bo")));
  let t = task_exn (world root) "T-4f5a" in
  Alcotest.(check (list string)) "folded"
    [ "waiting"; "relay-core"; "P-5e6f"; "bo" ]
    [ t.status; t.product; Option.get t.project_id; t.owner ];
  Alcotest.(check (option string)) "cleared due" None t.due;
  ignore (ok (set "4f5a" "owner" None));
  Alcotest.(check string) "owner null resets to me" "me" (task_exn (world root) "T-4f5a").owner;
  unchanged_by root (fun () ->
      Alcotest.(check bool) "clearing an unset value, or an owner already me, writes nothing" true
        (snd (ok (set "4f5a" "owner" None)) = Write_task.Unchanged
        && snd (ok (set "4f5a" "due" None)) = Write_task.Unchanged));
  ignore (ok (set "4f5a" "title" (Some "  Calibrate twice ")));
  Alcotest.(check string) "title stripped" "Calibrate twice" (task_exn (world root) "T-4f5a").title

let test_list_items () =
  let root, c = setup () in
  let add task field value = Write_task.add_item c ~task ~field ~value () in
  let rm task field value = Write_task.remove_item c ~task ~field ~value () in
  Alcotest.(check bool) "add tag" true
    (ok (add "4f5a" "tags" "review") = ("T-4f5a", Write_task.Changed));
  unchanged_by root (fun () ->
      Alcotest.(check bool) "present value: nothing written" true
        (ok (add "4f5a" "tags" "review") = ("T-4f5a", Write_task.Unchanged));
      List.iter
        (fun (name, kind, r) -> check_error name kind r)
        [ ("remove absent", Err.Usage, Result.map (fun x -> (x, Write_task.Changed)) (rm "4f5a" "tags" "absent"));
          ("blank value", Err.Usage, add "4f5a" "links" "  ");
          ("unknown list field", Err.Usage, add "4f5a" "colours" "red");
          ("also needs a product", Err.Usage, add "4f5a" "also" "nosuch");
          ("blocked_by itself", Err.Usage, add "4f5a" "blocked_by" "4f5a");
          ("blocked_by unknown", Err.Not_found, add "4f5a" "blocked_by" "beef") ]);
  ignore (ok (add "4f5a" "blocked_by" "9c"));
  ignore (ok (add "4f5a" "also" "relay-edge"));
  Alcotest.(check strings) "blocked_by stores the full id" [ "T-9c0d" ]
    (task_exn (world root) "T-4f5a").blocked_by;
  ignore (ok (rm "4f5a" "tags" "review"));
  ignore (ok (rm "4f5a" "blocked_by" "9c0d"));
  let t = task_exn (world root) "T-4f5a" in
  Alcotest.(check (list string)) "removed" [] (t.tags @ t.blocked_by);
  Alcotest.(check strings) "also kept" [ "relay-edge" ] t.also

(* ---- log, note, link ----------------------------------------------------- *)

let test_log () =
  let root, c = setup () in
  let log ?kind ?date ?prov text = Write_task.log c ~task:"4f5a" ?kind ?date ?prov text in
  ignore (ok (log "scale calibrated"));
  Alcotest.(check string) "progress event, no agent without a session"
    "{\"ts\":\"2026-11-10T12:00:00Z\",\"task\":\"T-4f5a\",\"type\":\"progress\",\"text\":\"scale calibrated\"}"
    (last_line root);
  ignore (ok (log ~kind:"decision" ~prov:"inferred" "weigh twice"));
  Alcotest.(check bool) "prov recorded when not stated" true
    (contains ~sub:"\"text\":\"weigh twice\",\"prov\":\"inferred\"" (last_line root));
  ignore (ok (log ~kind:"learning" ~prov:"stated" "a plain learning"));
  Alcotest.(check bool) "stated omitted" false (contains ~sub:"prov" (last_line root));
  ignore (ok (log ~kind:"shipped" "released"));
  Alcotest.(check bool) "shipped date defaults to today (UTC)" true
    (contains ~sub:"\"date\":\"2026-11-10\"" (last_line root));
  ignore (ok (log ~kind:"shipped" ~date:"2026-11-09" "released earlier"));
  Alcotest.(check bool) "explicit date" true
    (contains ~sub:"\"date\":\"2026-11-09\"" (last_line root));
  unchanged_by root (fun () ->
      List.iter
        (fun (name, r) -> check_error name Err.Usage r)
        [ ("date with another kind", log ~kind:"risk" ~date:"2026-11-09" "x");
          ("invalid date", log ~kind:"shipped" ~date:"2026-13-01" "x");
          ("unknown kind", log ~kind:"gossip" "x");
          ("unknown prov", log ~prov:"guessed" "x");
          ("empty text", log "  ");
          ("NUL", log "a\000b");
          ("too long", log (String.make 8001 'x')) ];
      check_error "unknown task" Err.Not_found (Write_task.log c ~task:"beef" "x"));
  ignore (ok (log "multi\nline text kept"));
  Alcotest.(check bool) "newlines allowed in text" true
    (contains ~sub:"multi\\nline text kept" (last_line root));
  Alcotest.(check (option string)) "last_note follows progress only" (Some "multi\nline text kept")
    (task_exn (world root) "T-4f5a").last_note

let test_auto_link () =
  let root, c = setup () in
  let s = session ~cwd:"/work/app" ~repo:"/work/app" ~branch:"main" () in
  ignore (ok (Write_task.log c ~session:s ~task:"4f5a" "first"));
  let tail =
    List.rev
      (List.filter (fun l -> l <> "")
         (String.split_on_char (Char.chr 10) (read_file (Filename.concat root "events/2026-11.hosta.jsonl"))))
  in
  Alcotest.(check bool) "the progress event is last" true
    (contains ~sub:"\"type\":\"progress\"" (List.hd tail));
  Alcotest.(check string) "session_linked written first, same second"
    "{\"ts\":\"2026-11-10T12:00:00Z\",\"task\":\"T-4f5a\",\"type\":\"session_linked\",\"agent\":\"claude\",\"session\":\"s-test\",\"cwd\":\"/work/app\",\"host\":\"hosta\",\"repo\":\"/work/app\",\"branch\":\"main\"}"
    (List.nth tail 1);
  ignore (ok (Write_task.log c ~session:s ~task:"4f5a" "second"));
  Alcotest.(check int) "linked once" 1
    (List.length
       (List.filter (contains ~sub:"session_linked")
          (List.filter (contains ~sub:"T-4f5a") (event_lines root))));
  ignore
    (ok (Write_task.note c ~session:(session ~id:"s-other" ()) ~task:"4f5a" ~prov:"confirmed" "context"));
  Alcotest.(check bool) "note never links" true
    (List.length (task_exn (world root) "T-4f5a").sessions = 1);
  Alcotest.(check bool) "note event" true
    (contains ~sub:"\"type\":\"note\",\"text\":\"context\",\"prov\":\"confirmed\"" (last_line root));
  let id, o = ok (Write_task.link c ~session:(session ~id:"s-third" ()) ~task:"4f5a" ()) in
  Alcotest.(check bool) "explicit link" true ((id, o) = ("T-4f5a", Write_task.Changed));
  unchanged_by root (fun () ->
      Alcotest.(check bool) "already linked: nothing" true
        (snd (ok (Write_task.link c ~session:(session ~id:"s-third" ()) ~task:"4f5a" ()))
        = Write_task.Unchanged);
      check_error "no session" Err.Usage (Write_task.link c ~task:"4f5a" ());
      check_error "agent only" Err.Usage
        (Write_task.link c ~session:(ok (Session.make ~agent:"claude" ())) ~task:"4f5a" ()))

(* ---- blockers ------------------------------------------------------------ *)

let test_blockers () =
  let root, c = setup () in
  let bid = ok (Write_task.block c ~task:"4f5a" ~kind:"review" ~on:"Ana" "waiting for sign-off") in
  Alcotest.(check bool) "blocker id" true (Fields.valid_blocker_id bid && String.length bid = 8);
  Alcotest.(check string) "event: id, kind, on, text"
    (Printf.sprintf
       "{\"ts\":\"2026-11-10T12:00:00Z\",\"task\":\"T-4f5a\",\"type\":\"blocker\",\"id\":\"%s\",\"kind\":\"review\",\"on\":\"Ana\",\"text\":\"waiting for sign-off\"}"
       bid)
    (last_line root);
  Alcotest.(check string) "status unchanged" "in_progress" (task_exn (world root) "T-4f5a").status;
  let second = ok (Write_task.block c ~task:"4f5a" "second blocker") in
  Alcotest.(check bool) "ids are distinct, kind defaults to other" true
    (second <> bid && contains ~sub:"\"kind\":\"other\"" (last_line root));
  unchanged_by root (fun () ->
      let r = Write_task.unblock c ~task:"4f5a" () in
      check_error "two open: ambiguous" Err.Not_found r;
      (match r with
      | Error e ->
          Alcotest.(check bool) "lists them" true
            (contains ~sub:bid e.message && contains ~sub:second e.message)
      | Ok _ -> ());
      check_error "bad kind" Err.Usage (Write_task.block c ~task:"4f5a" ~kind:"weird" "x");
      check_error "empty text" Err.Usage (Write_task.block c ~task:"4f5a" " ");
      check_error "unknown blocker" Err.Not_found
        (Write_task.unblock c ~task:"4f5a" ~blocker:"B-ffffff" ());
      check_error "no open blocker" Err.Not_found (Write_task.unblock c ~task:"1a2b" ()));
  Alcotest.(check string) "by prefix" bid
    (ok (Write_task.unblock c ~task:"4f5a" ~blocker:(String.sub bid 0 5) ~text:"signed" ()));
  Alcotest.(check string) "the only open one by default" second
    (ok (Write_task.unblock c ~task:"4f5a" ()));
  check_error "already resolved" Err.Not_found (Write_task.unblock c ~task:"4f5a" ~blocker:bid ());
  Alcotest.(check int) "all resolved" 0
    (List.length
       (List.filter
          (fun (b : Model.blocker) -> b.resolved = None)
          (task_exn (world root) "T-4f5a").blockers))

(* ---- projects ------------------------------------------------------------ *)

let test_projects () =
  let root, c = setup () in
  let id =
    ok
      (Write_project.add c ~title:" Harbour upgrade " ~product:"relay" ~quarter:"2027Q1"
         ~owner:"ana" ~hlp:"https://example.test/plan" ~goal:"double throughput"
         ~milestones:[ "survey"; "build" ] ~risks:[ "weather" ] ())
  in
  let p = project_exn (world root) id in
  Alcotest.(check (list string)) "folded"
    [ "Harbour upgrade"; "relay"; "platform"; "2027Q1"; "ana" ]
    [ p.title_p; p.product_p; p.category_p; Option.get p.quarter; Option.get p.owner_p ];
  Alcotest.(check (list string)) "lists" [ "build"; "survey"; "weather" ] (p.milestones @ p.risks);
  Alcotest.(check bool) "no file created for a project" false
    (List.exists (fun (n, _) -> contains ~sub:id n) (tree_snapshot (Filename.concat root "tasks")));
  unchanged_by root (fun () ->
      List.iter
        (fun (name, kind, r) -> check_error name kind r)
        [ ("duplicate title, any case, same product", Err.Usage,
           Write_project.add c ~title:"HARBOUR UPGRADE" ~product:"relay" ());
          ("empty title", Err.Usage, Write_project.add c ~title:" " ~product:"relay" ());
          ("unknown product", Err.Usage, Write_project.add c ~title:"x" ~product:"nosuch" ());
          ("bad quarter", Err.Usage,
           Write_project.add c ~title:"x" ~product:"relay" ~quarter:"2027Q9" ());
          ("blank milestone", Err.Usage,
           Write_project.add c ~title:"x" ~product:"relay" ~milestones:[ " " ] ()) ]);
  ignore (ok (Write_project.add c ~title:"Harbour upgrade" ~product:"gateway" ()));
  let set field value = Write_project.set c ~project:id ~field ~value () in
  Alcotest.(check bool) "set status" true (ok (set "status" (Some "done")) = (id, Write_task.Changed));
  Alcotest.(check bool) "set product carries the category" true
    (snd (ok (set "product" (Some "gateway"))) = Write_task.Changed
    && contains ~sub:"\"to\":\"gateway\",\"category\":\"platform\"" (last_line root));
  ignore (ok (set "quarter" None));
  unchanged_by root (fun () ->
      Alcotest.(check bool) "same value" true
        (snd (ok (set "status" (Some "done"))) = Write_task.Unchanged);
      Alcotest.(check bool) "already cleared" true
        (snd (ok (set "quarter" None)) = Write_task.Unchanged);
      List.iter
        (fun (name, kind, r) -> check_error name kind r)
        [ ("title cannot be cleared", Err.Usage, set "title" None);
          ("bad status", Err.Usage, set "status" (Some "blocked"));
          ("unknown product", Err.Usage, set "product" (Some "nosuch"));
          ("unknown field", Err.Usage, set "colour" (Some "red"));
          ("unknown project", Err.Not_found,
           Write_project.set c ~project:"beef" ~field:"goal" ~value:(Some "x") ()) ]);
  let p = project_exn (world root) id in
  Alcotest.(check (list string)) "after sets" [ "done"; "gateway" ] [ p.status_p; p.product_p ];
  Alcotest.(check (option string)) "cleared" None p.quarter

let test_project_items () =
  let root, c = setup () in
  let id = ok (Write_project.add c ~title:"With lists" ~product:"relay" ()) in
  Alcotest.(check bool) "add item" true
    (snd (ok (Write_project.add_item c ~project:id ~field:"risks" ~value:"fog" ())) = Write_task.Changed);
  Alcotest.(check bool) "present item" true
    (snd (ok (Write_project.add_item c ~project:id ~field:"risks" ~value:"fog" ())) = Write_task.Unchanged);
  ignore (ok (Write_project.remove_item c ~project:id ~field:"risks" ~value:"fog" ()));
  check_error "remove absent" Err.Usage
    (Write_project.remove_item c ~project:id ~field:"risks" ~value:"fog" ());
  check_error "unknown list" Err.Usage
    (Write_project.add_item c ~project:id ~field:"tags" ~value:"x" ());
  ignore (ok (Write_task.set c ~task:"4f5a" ~field:"project" ~value:(Some id) ()));
  let row = ok (Query.get_project (world root) id) in
  Alcotest.(check int) "a task joined the project" 1 row.open_tasks

(* ---- round trip, clock ---------------------------------------------------- *)

let test_round_trip () =
  let root, c = setup () in
  let s = session ~cwd:"/w" () in
  let id =
    ok (Write_task.add c ~session:s ~title:"Round trip" ~product:"relay-edge" ~tags:[ "a" ] ())
  in
  ignore (ok (Write_task.set c ~session:s ~task:id ~field:"status" ~value:(Some "in_progress") ()));
  ignore (ok (Write_task.log c ~session:s ~task:id ~kind:"decision" "decided"));
  let bid = ok (Write_task.block c ~session:s ~task:id "stuck") in
  ignore (ok (Write_task.unblock c ~session:s ~task:id ~blocker:bid ()));
  let project = ok (Write_project.add c ~session:s ~title:"RT project" ~product:"relay" ()) in
  ignore (ok (Write_task.set c ~task:id ~field:"project" ~value:(Some project) ()));
  let loaded = load root in
  Alcotest.(check int) "every line we wrote reads back: only the fixture's own 5 warnings remain" 5
    (List.length loaded.warnings);
  let t = task_exn loaded.world id in
  Alcotest.(check (list string)) "state read back"
    [ "Round trip"; "relay-edge"; "in_progress"; "a"; project ]
    [ t.title; t.product; t.status; List.hd t.tags; Option.get t.project_id ];
  Alcotest.(check int) "sessions" 1 (List.length t.sessions);
  Alcotest.(check bool) "blocker resolved" true
    (List.for_all (fun (b : Model.blocker) -> b.resolved <> None) t.blockers);
  let events, _ = Store.read_events c in
  let again = Fold.fold (List.rev events) ignore in
  Alcotest.(check string) "refold gives the same state" (dump_world loaded.world) (dump_world again)

let test_clock_clamp () =
  let root, _ = setup () in
  let early = ts "2026-11-01T00:00:00Z" in
  let c_old = ctx ~now:early root in
  ignore (ok (Write_task.log c_old ~task:"4f5a" "behind the newest event"));
  Alcotest.(check bool) "ts clamped to the host's own newest" true
    (contains ~sub:"\"ts\":\"2026-11-09T08:01:00Z\"" (last_line root));
  let c_new_host = ctx ~host:"hostz" ~now:early root in
  ignore (ok (Write_task.log c_new_host ~task:"4f5a" "another host keeps its own clock"));
  Alcotest.(check bool) "other host not clamped" true
    (List.exists (contains ~sub:"\"ts\":\"2026-11-01T00:00:00Z\"") (event_lines root));
  Alcotest.(check bool) "written to the host's own file" true
    (Sys.file_exists (Filename.concat root "events/2026-11.hostz.jsonl"));
  let c_next_month = ctx ~now:(ts "2026-12-02T03:04:05Z") root in
  ignore (ok (Write_task.log c_next_month ~task:"4f5a" "next month"));
  Alcotest.(check bool) "new month, new file" true
    (Sys.file_exists (Filename.concat root "events/2026-12.hosta.jsonl"))

let () =
  Alcotest.run "worklog writer"
    [ ( "add",
        [ Alcotest.test_case "minimal task" `Quick test_add_minimal;
          Alcotest.test_case "every option" `Quick test_add_full;
          Alcotest.test_case "validation writes nothing" `Quick test_add_validation;
          Alcotest.test_case "id collision" `Quick test_add_id_collision ] );
      ( "fields",
        [ Alcotest.test_case "set" `Quick test_set;
          Alcotest.test_case "list items" `Quick test_list_items ] );
      ( "events",
        [ Alcotest.test_case "log and kinds" `Quick test_log;
          Alcotest.test_case "session link" `Quick test_auto_link;
          Alcotest.test_case "blockers" `Quick test_blockers ] );
      ( "projects",
        [ Alcotest.test_case "projects" `Quick test_projects;
          Alcotest.test_case "milestones and risks" `Quick test_project_items ] );
      ( "state",
        [ Alcotest.test_case "round trip" `Quick test_round_trip;
          Alcotest.test_case "clock and months" `Quick test_clock_clamp ] ) ]
