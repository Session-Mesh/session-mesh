(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The read side from a context: load the repository and answer the derived
    reads. Reads take no lock and never fail on malformed data; what was
    skipped is reported in [warnings]. A taxonomy that cannot be loaded makes
    product filters match exactly (no roll-up) and adds one warning. *)

type snapshot = {
  loaded : Store.loaded;
  taxonomy : Taxonomy.t option;
  warnings : string list;  (** read and fold warnings, then the taxonomy's *)
}

val snapshot : Ctx.t -> (snapshot, Err.t) result
(** Load and fold the repository. An unreadable directory is an [Error]; no
    reader function raises. *)

val list_tasks :
  Ctx.t -> Query.task_filter -> (Model.task list * string list, Err.t) result
(** Filtered tasks (product filters roll up through the taxonomy) and the
    warnings of the read. *)

val get_task : Ctx.t -> string -> (Query.task_view * string list, Err.t) result

val resume :
  Ctx.t ->
  ?where:Resume.where ->
  ?stale_days:int ->
  ?show_all:bool ->
  ?filter:Query.task_filter ->
  unit ->
  (Resume.report * string list, Err.t) result
(** The briefing at the context's clock. [filter] narrows by product
    (rolled up), project, track, owner, session and category. *)

val list_projects :
  Ctx.t ->
  ?product:string ->
  ?status:string list ->
  ?quarter:string ->
  ?include_closed:bool ->
  unit ->
  (Query.project_row list * string list, Err.t) result

val get_project : Ctx.t -> string -> (Query.project_row * Model.task list * string list, Err.t) result
(** A project with its counts and its tasks (open ones first). *)
