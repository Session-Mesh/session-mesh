(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module R = Work_mcp.Work_render
module Q = Work_mcp.Work_questions
module E = Work_mcp.Work_err
open E

let section_cap = 25
let max_row_blockers = 5
let max_open_questions = 20

let row_json ~attempts world (row : W.Resume.row) =
  let base = match Wr_view.task_row ~attempts world row.task with `Assoc l -> l | _ -> [] in
  `Assoc
    (base
    @ [ ("days_since_activity", `Int row.days) ]
    @ Wr_out.list "open_blockers" max_row_blockers (List.map R.blocker_json row.open_blockers)
    @ if row.unblock then [ ("all_blocked_by_tasks_finished", `Bool true) ] else [])

let sections (loaded : Wr_load.t) ?keep ?(show_all = false) () =
  let world = Wr_load.world loaded in
  let report = W.Resume.build world ~now:(loaded.ctx.now ()) ?keep ~show_all () in
  let section name rows = Wr_out.list name section_cap (List.map (row_json ~attempts:loaded.attempts world) rows) in
  section "in_progress" report.in_progress
  @ section "blocked" report.blocked
  @ section "stale" report.stale
  @ section "due" report.due
  @ if show_all then section "todo" report.todo else []

let keep_of (loaded : Wr_load.t) ~product ~project =
  let world = Wr_load.world loaded in
  let taxonomy = loaded.snapshot.taxonomy in
  let* project = match project with None -> Ok None | Some p -> Result.map Option.some (lift (W.Refs.project world p)) in
  let filter = { W.Query.no_filter with product } in
  Ok (project, fun t -> W.Query.matches ~world ?taxonomy ~project filter t)

(* What a question may be about to belong to the scope: the tasks kept, and
   the project given or the projects of the product. No scope: everything. *)
let in_scope (loaded : Wr_load.t) ~product ~project keep =
  let world = Wr_load.world loaded in
  let tasks = W.Model.Smap.fold (fun id t acc -> if keep t then id :: acc else acc) world.tasks [] in
  let projects =
    match (project, product) with
    | Some pid, _ -> [ pid ]
    | None, Some _ ->
        List.map
          (fun (row : W.Query.project_row) -> row.project.pid)
          (W.Query.list_projects world ?taxonomy:loaded.snapshot.taxonomy ?product ~include_closed:true ())
    | None, None -> []
  in
  fun (q : Q.question) -> match q.about with Some a -> List.mem a tasks || List.mem a projects | None -> false

let run loaded ~product ~project ~all =
  let* () = Wr_scope.check_product loaded product in
  let* pid, keep = keep_of loaded ~product ~project in
  let opened = List.filter Q.is_open loaded.questions in
  let opened =
    if product = None && project = None then opened else List.filter (in_scope loaded ~product ~project:pid keep) opened
  in
  Ok
    (Wr_out.document "resume"
       (sections loaded ~keep ~show_all:all ()
       @ [ ("open_questions", `Int (List.length opened)) ]
       @ Wr_out.list "questions" max_open_questions
           (List.map (Wr_questions.to_json ~brief:true) (Wr_questions.ordered opened))
       @ Wr_load.warnings_json loaded))
