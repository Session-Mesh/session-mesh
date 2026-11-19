(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [resume]: the library's briefing without a session. The [here] section is
    always empty (it needs a caller), so it is left out. Each section holds at
    most 25 rows. *)

val section_cap : int

val sections :
  Wr_load.t ->
  ?keep:(Mesh_worklog.Model.task -> bool) ->
  ?show_all:bool ->
  unit ->
  (string * Yojson.Safe.t) list
(** [in_progress], [blocked], [stale], [due] (due within 7 days or overdue) and,
    with [show_all], [todo]; each row is the compact task of {!Wr_view.task_row}
    plus [days_since_activity], [open_blockers] (blocker records, at most 5)
    and [all_blocked_by_tasks_finished]. [keep] narrows the tasks considered. *)

val run :
  Wr_load.t -> product:string option -> project:string option -> all:bool -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
(** The sections, then the open questions ({!Wr_questions.ordered}, at most
    20, shortened). With a product or a project, only the questions about a
    task in that scope, about the project, or about a project of the product
    (descendants included) are counted and shown. *)
