(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Derived reads over a folded world: task listing, one task in full, project
    listing with progress. Pure except {!get_task}, which reads the notes of
    the task file. *)

type task_filter = {
  product : string option;  (** the product and its descendants when a taxonomy is given *)
  project : string option;  (** a project reference ([P-<hex>], bare hex or prefix) *)
  status : string list;  (** any of these statuses; empty means the default below *)
  include_closed : bool;  (** with no [status], also list [done] and [dropped] *)
  track : string option;
  owner : string option;
  session : string option;  (** tasks linked to this session id *)
  category : string option;
}

val no_filter : task_filter

val product_scope : ?taxonomy:Taxonomy.t -> string -> string list
(** The ids a product filter matches: the product and its descendants, or the
    product alone when there is no taxonomy or it does not know it. *)

val matches : world:Model.world -> ?taxonomy:Taxonomy.t -> project:string option -> task_filter -> Model.task -> bool
(** Whether a task passes every field of the filter except [status] and
    [include_closed]; [project] is the already resolved project id. *)

val list_tasks :
  Model.world -> ?taxonomy:Taxonomy.t -> task_filter -> (Model.task list, Err.t) result
(** Tasks passing the filter, ordered by priority then id. The default hides
    [done] and [dropped]. *)

type task_view = {
  task : Model.task;
  project_title : string option;  (** [None] when the task has no project or the project is unknown *)
  open_blockers : Model.blocker list;
  notes : string;  (** body of the task file, empty when there is none *)
  warnings : string list;  (** such as a task file that disagrees with the events *)
}

val get_task : Ctx.t -> Model.world -> string -> (task_view, Err.t) result
(** One task by reference: folded fields, open blockers, sessions, the full
    timeline (on [task]) and the notes. *)

type project_row = {
  project : Model.project;
  open_tasks : int;  (** assigned tasks that are neither [done] nor [dropped] *)
  done_tasks : int;  (** assigned tasks with status [done] *)
  progress : float option;  (** done / (open + done); [None] when both are 0 *)
}

val list_projects :
  Model.world ->
  ?taxonomy:Taxonomy.t ->
  ?product:string ->
  ?status:string list ->
  ?quarter:string ->
  ?include_closed:bool ->
  unit ->
  project_row list
(** Projects ordered by (product, title, id). The default lists [active]
    projects; [include_closed] adds [done] and [dropped]. *)

val get_project : Model.world -> string -> (project_row, Err.t) result
(** One project by reference, with its counts. *)

val tasks_of_project : Model.world -> string -> Model.task list
(** Tasks assigned to a project id: open ones first, then by priority and id. *)
