(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Model

type where = {
  host : string;
  cwd : string;
  home : string option;
  session : string option;
  repo : string option;
  branch : string option;
}

type row = {
  task : task;
  days : int;
  last_note : string option;
  tier : int option;
  open_blockers : blocker list;
  unblock : bool;
  project_title : string option;
}

type report = {
  here : row list;
  in_progress : row list;
  blocked : row list;
  stale : row list;
  due : row list;
  todo : row list;
}

let here_cap = 5
let due_days = 7
let is_closed (t : task) = t.status = "done" || t.status = "dropped"

let has_prefix ~prefix s =
  String.length s >= String.length prefix
  && String.sub s 0 (String.length prefix) = prefix

let rstrip_slash s =
  let n = ref (String.length s) in
  while !n > 0 && s.[!n - 1] = '/' do decr n done;
  String.sub s 0 !n

let link_tier (w : where) (l : session_link) =
  if w.session <> None && Some l.session = w.session then 1
  else if l.link_host <> Some w.host then 0
  else if w.repo <> None && w.branch <> None && l.repo = w.repo && l.branch = w.branch then 2
  else
    match l.cwd with
    | Some cwd
      when cwd <> "" && cwd <> "/" && Some cwd <> w.home
           && (w.cwd = cwd || has_prefix ~prefix:(rstrip_slash cwd ^ "/") w.cwd) ->
        3
    | _ -> 0

let best_link w (t : task) =
  List.fold_left
    (fun best (l : session_link) ->
      match (link_tier w l, best) with
      | 0, _ -> best
      | tier, None -> Some (tier, l.linked_at)
      | tier, Some (bt, bat) ->
          if tier < bt || (tier = bt && l.linked_at > bat) then Some (tier, l.linked_at) else best)
    None t.sessions

let here_candidates w tasks =
  List.filter_map (fun t -> Option.map (fun (tier, at) -> (tier, at, t)) (best_link w t)) tasks
  |> List.sort (fun (t1, a1, (x : task)) (t2, a2, (y : task)) ->
         compare (t1, -a1, x.id) (t2, -a2, y.id))

let project_title world (t : task) =
  Option.map
    (fun pid ->
      match Smap.find_opt pid world.projects with
      | Some p -> p.title_p
      | None -> pid ^ " (unknown)")
    t.project_id

let make_row world ~now ?tier (t : task) =
  let by_id id = Smap.find_opt id world.tasks in
  let unblock =
    t.blocked_by <> []
    && List.for_all
         (fun id -> match by_id id with Some d -> is_closed d | None -> false)
         t.blocked_by
  in
  {
    task = t;
    days = (match t.last_ts with Some ts -> max 0 ((now - ts) / Tstamp.seconds_per_day) | None -> 0);
    last_note = Option.bind t.last_note (fun n -> Textcheck.first_line n);
    tier;
    open_blockers = List.filter (fun b -> b.resolved = None) t.blockers;
    unblock;
    project_title = project_title world t;
  }

let structured tasks =
  List.exists (fun (t : task) -> t.project_id <> None || t.track <> None) tasks

(* (product, has project, project title, project id, has track, track) *)
let order_prefix world (t : task) =
  let title = Option.value (project_title world t) ~default:"" in
  ( t.product,
    (if t.project_id <> None then 0 else 1),
    title,
    Option.value t.project_id ~default:"",
    (if t.track <> None then 0 else 1),
    Option.value t.track ~default:"" )

let recency (t : task) = match t.last_ts with Some ts -> -ts | None -> 0

let sorted world ~on ~key tasks =
  let cmp a b =
    let k = compare (key a) (key b) in
    if on then
      let p = compare (order_prefix world a) (order_prefix world b) in
      if p <> 0 then p else k
    else k
  in
  List.sort cmp tasks

type buckets = {
  mutable b_here : task list;
  mutable b_in_progress : task list;
  mutable b_blocked : task list;
  mutable b_stale : task list;
  mutable b_due : task list;
  mutable b_todo : task list;
}

let place b ~now ~stale_after ~due_limit ~show_all (t : task) =
  if t.status = "blocked" || t.status = "waiting" || List.exists (fun x -> x.resolved = None) t.blockers
  then b.b_blocked <- t :: b.b_blocked
  else if (match t.due with Some d -> d <= due_limit | None -> false) then b.b_due <- t :: b.b_due
  else if t.status = "in_progress" then
    match t.last_ts with
    | Some ts when now - ts > stale_after -> b.b_stale <- t :: b.b_stale
    | _ -> b.b_in_progress <- t :: b.b_in_progress
  else if show_all && (t.status = "todo" || t.status = "inbox") then b.b_todo <- t :: b.b_todo

let build world ~now ?where ?(stale_days = 5) ?(show_all = false) ?(keep = fun _ -> true) () =
  let live =
    Smap.fold (fun _ (t : task) acc -> if (not (is_closed t)) && keep t then t :: acc else acc) world.tasks []
  in
  let b = { b_here = []; b_in_progress = []; b_blocked = []; b_stale = []; b_due = []; b_todo = [] } in
  let here =
    match where with
    | None -> []
    | Some w -> List.filteri (fun i _ -> i < here_cap) (here_candidates w live)
  in
  let placed = List.map (fun (_, _, (t : task)) -> t.id) here in
  let due_limit = Tstamp.add_days (Tstamp.date_of now) due_days in
  List.iter
    (fun (t : task) ->
      if not (List.mem t.id placed) then
        place b ~now ~stale_after:(stale_days * Tstamp.seconds_per_day) ~due_limit ~show_all t)
    live;
  (* As in wl: the placement order applies only when a task shown in some
     section has a project or a track (tasks left out of every section do not count). *)
  let shown =
    List.map (fun (_, _, t) -> t) here
    @ List.concat [ b.b_in_progress; b.b_blocked; b.b_stale; b.b_due; b.b_todo ]
  in
  let on = structured shown in
  let order key l = sorted world ~on ~key l in
  let rows l = List.map (fun t -> make_row world ~now t) l in
  let prio_recency (t : task) = (t.priority, recency t, t.id) in
  {
    here = List.map (fun (tier, _, t) -> make_row world ~now ~tier t) here;
    in_progress = rows (order prio_recency b.b_in_progress);
    blocked = rows (order prio_recency b.b_blocked);
    stale = rows (order (fun (t : task) -> (-recency t, t.priority, t.id)) b.b_stale);
    due = rows (order (fun (t : task) -> (Option.value t.due ~default:"", t.priority, t.id)) b.b_due);
    todo = rows (order (fun (t : task) -> (t.priority, 0, t.id)) b.b_todo);
  }
