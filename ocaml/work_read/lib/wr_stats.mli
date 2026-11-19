(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Counts over groups of tasks. Nothing is stored: every figure is computed
    from the folded world. *)

type t = {
  open_tasks : int;  (** neither [done] nor [dropped] *)
  done_tasks : int;  (** status [done] *)
  blocked_tasks : int;  (** open tasks that are blocked ({!is_blocked}) *)
  dependency_open_tasks : int;
      (** open tasks with a [blocked_by] task that is still open (an unknown
          target does not count); a separate notion from [blocked_tasks]: a
          task can be both, either or neither *)
  open_blockers : int;  (** unresolved blockers of open tasks *)
}

val empty : t
val add : t -> t -> t

val is_open : Mesh_worklog.Model.task -> bool
val open_blockers : Mesh_worklog.Model.task -> Mesh_worklog.Model.blocker list

val is_blocked : Mesh_worklog.Model.task -> bool
(** The one meaning of "blocked" in every document ([blocked_tasks], the
    [blocked] column, the [blocked] resume section): an open task whose status
    is [blocked] or [waiting], or that has an unresolved blocker. This is the
    definition of the library's resume. *)

val unfinished_dependency : Mesh_worklog.Model.world -> Mesh_worklog.Model.task -> bool
(** Some [blocked_by] target exists and is still open. *)

val state : Mesh_worklog.Model.world -> string -> string
(** The state of a task id: [open], [finished] ([done] or [dropped]) or
    [unknown] (no such task). *)

val of_tasks : Mesh_worklog.Model.world -> Mesh_worklog.Model.task list -> t

val progress : t -> float option
(** [done / (open + done)]; [None] when both are 0. *)

val json : t -> (string * Yojson.Safe.t) list
(** [open], [done], [blocked_tasks], [dependency_open_tasks], [blockers] and [progress] (absent when
    there is no task to count). *)
