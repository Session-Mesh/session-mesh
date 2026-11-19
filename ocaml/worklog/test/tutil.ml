(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Helpers shared by the worklog tests. *)

open Mesh_worklog

let ts s = match Tstamp.parse s with Some t -> t | None -> failwith ("bad ts " ^ s)

(* The fixture's clock: after its newest event. *)
let fixture_now = ts "2026-11-10T12:00:00Z"
(* dune may hand the test its files as symbolic links, which the library refuses:
   tests read copies. *)
let fixture_source = "fixture"
let counter = ref 0

let temp_dir prefix =
  incr counter;
  let dir =
    Filename.concat (Filename.get_temp_dir_name ())
      (Printf.sprintf "%s-%d-%d-%d" prefix (Unix.getpid ()) !counter (Random.bits ()))
  in
  Appendfile.mkdir_p dir;
  dir

let read_file path = In_channel.with_open_bin path In_channel.input_all

let write_file path content =
  Appendfile.mkdir_p (Filename.dirname path);
  Out_channel.with_open_bin path (fun oc -> output_string oc content)

let rec copy_tree src dst =
  if Sys.is_directory src then begin
    Appendfile.mkdir_p dst;
    Array.iter (fun f -> copy_tree (Filename.concat src f) (Filename.concat dst f)) (Sys.readdir src)
  end
  else write_file dst (read_file src)

let copy_of source prefix =
  let dir = temp_dir prefix in
  copy_tree source dir;
  dir

let fixture_copy () = copy_of fixture_source "wlfix"

(* One shared copy for the tests that only read. *)
let fixture_dir = fixture_copy ()

(* A context with a fixed clock, a seeded generator and no git commit. *)
let ctx ?(host = "hosta") ?(now = fixture_now) ?(commit = false) ?(seed = 7) ?lock_timeout ?warn root =
  Ctx.make ~root ~host ~now:(fun () -> now) ~rng:(Random.State.make [| seed |]) ~commit
    ?lock_timeout ?warn ()

let ok = function
  | Ok v -> v
  | Error (e : Err.t) -> Alcotest.failf "unexpected error: %s" e.message

let error_kind = function
  | Ok _ -> None
  | Error (e : Err.t) -> Some e.kind

let check_error name kind r =
  match error_kind r with
  | Some k -> Alcotest.(check bool) name true (k = kind)
  | None -> Alcotest.failf "%s: expected an error" name

let contains ~sub s =
  let n = String.length sub and m = String.length s in
  let rec go i = i + n <= m && (String.sub s i n = sub || go (i + 1)) in
  go 0

let has_warning ~sub warnings = List.exists (contains ~sub) warnings

(* Every file under a directory with its content, for "nothing was written". *)
let rec tree_snapshot dir =
  Array.to_list (Sys.readdir dir)
  |> List.sort String.compare
  |> List.concat_map (fun f ->
         let path = Filename.concat dir f in
         if f = ".wl.lock" || f = ".git" then []
         else if Sys.is_directory path then
           List.map (fun (p, c) -> (f ^ "/" ^ p, c)) (tree_snapshot path)
         else [ (f, read_file path) ])

let event_lines root =
  let dir = Filename.concat root "events" in
  if not (Sys.file_exists dir) then []
  else
    Array.to_list (Sys.readdir dir)
    |> List.sort String.compare
    |> List.concat_map (fun f ->
           String.split_on_char '\n' (read_file (Filename.concat dir f))
           |> List.filter (fun l -> l <> ""))

(* A canonical text of a folded world, for equality checks. *)
let opt = function Some s -> s | None -> "-"

let dump_task (t : Model.task) =
  Printf.sprintf
    "%s|%s/%s|home %s/%s|%s|%s|%s|due %s|tags %s|links %s|by %s|also %s|proj %s|track %s|owner %s|eta %s|size %s|origin %s|last %s|note %s|sessions %s|blockers %s|timeline %d"
    t.id t.product t.category t.home_product t.home_category t.title t.status t.priority
    (opt t.due) (String.concat "," t.tags) (String.concat "," t.links)
    (String.concat "," t.blocked_by) (String.concat "," t.also) (opt t.project_id)
    (opt t.track) t.owner (opt t.eta) (opt t.size) (opt t.origin)
    (match t.last_ts with Some x -> Tstamp.format x | None -> "-")
    (opt t.last_note)
    (String.concat ","
       (List.map (fun (s : Model.session_link) -> s.agent ^ ":" ^ s.session) t.sessions))
    (String.concat ","
       (List.map
          (fun (b : Model.blocker) ->
            Printf.sprintf "%s/%s/%s/%s" b.blocker_id b.kind (opt b.on)
              (match b.resolved with Some x -> Tstamp.format x | None -> "open"))
          t.blockers))
    (List.length t.timeline)

let dump_project (p : Model.project) =
  Printf.sprintf "%s|%s|%s/%s|%s|q %s|owner %s|hlp %s|goal %s|ms %s|risks %s|last %s|timeline %d"
    p.pid p.title_p p.product_p p.category_p p.status_p (opt p.quarter) (opt p.owner_p) (opt p.hlp)
    (opt p.goal) (String.concat "," p.milestones) (String.concat "," p.risks)
    (match p.last_ts_p with Some x -> Tstamp.format x | None -> "-")
    (List.length p.timeline_p)

let dump_world (w : Model.world) =
  String.concat "\n"
    (List.map (fun (_, t) -> dump_task t) (Model.Smap.bindings w.tasks)
    @ List.map (fun (_, p) -> dump_project p) (Model.Smap.bindings w.projects))

let task_exn (w : Model.world) id = Model.Smap.find id w.tasks
let project_exn (w : Model.world) id = Model.Smap.find id w.projects
let load root = Store.load (ctx root)

let session ?(agent = "claude") ?(id = "s-test") ?cwd ?repo ?branch () =
  ok (Session.make ~agent ~session:id ?cwd ?repo ?branch ())

let git root args =
  match Gitrun.run ~dir:root args with
  | 0, out -> String.trim out
  | code, out -> Alcotest.failf "git %s failed (%d): %s" (String.concat " " args) code out
