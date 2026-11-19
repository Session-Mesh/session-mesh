(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog

type t = {
  open_tasks : int;
  done_tasks : int;
  blocked_tasks : int;
  dependency_open_tasks : int;
  open_blockers : int;
}

let empty = { open_tasks = 0; done_tasks = 0; blocked_tasks = 0; dependency_open_tasks = 0; open_blockers = 0 }

let add a b =
  {
    open_tasks = a.open_tasks + b.open_tasks;
    done_tasks = a.done_tasks + b.done_tasks;
    blocked_tasks = a.blocked_tasks + b.blocked_tasks;
    dependency_open_tasks = a.dependency_open_tasks + b.dependency_open_tasks;
    open_blockers = a.open_blockers + b.open_blockers;
  }

let is_open (t : W.Model.task) = t.status <> "done" && t.status <> "dropped"
let open_blockers (t : W.Model.task) = List.filter (fun (b : W.Model.blocker) -> b.resolved = None) t.blockers

(* The one meaning of "blocked" in every document, the one of the library's
   resume (its [blocked] section): an open task whose status is [blocked] or
   [waiting], or that has an unresolved blocker. *)
let is_blocked (t : W.Model.task) =
  is_open t && (t.status = "blocked" || t.status = "waiting" || open_blockers t <> [])

let unfinished_dependency (world : W.Model.world) (t : W.Model.task) =
  List.exists
    (fun id -> match W.Model.Smap.find_opt id world.tasks with Some d -> is_open d | None -> false)
    t.blocked_by

let state world id =
  match W.Model.Smap.find_opt id world.W.Model.tasks with
  | None -> "unknown"
  | Some t -> if is_open t then "open" else "finished"

let of_task world (t : W.Model.task) =
  if t.status = "done" then { empty with done_tasks = 1 }
  else if not (is_open t) then empty
  else
    {
      open_tasks = 1;
      done_tasks = 0;
      open_blockers = List.length (open_blockers t);
      blocked_tasks = (if is_blocked t then 1 else 0);
      dependency_open_tasks = (if unfinished_dependency world t then 1 else 0);
    }

let of_tasks world tasks = List.fold_left (fun acc t -> add acc (of_task world t)) empty tasks

let progress s =
  let total = s.open_tasks + s.done_tasks in
  if total = 0 then None else Some (float_of_int s.done_tasks /. float_of_int total)

let json s =
  [
    ("open", `Int s.open_tasks);
    ("done", `Int s.done_tasks);
    ("blocked_tasks", `Int s.blocked_tasks);
    ("dependency_open_tasks", `Int s.dependency_open_tasks);
    ("blockers", `Int s.open_blockers);
  ]
  @ match progress s with Some p -> [ ("progress", `Float p) ] | None -> []
