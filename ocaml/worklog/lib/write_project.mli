(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Writing the project entity [P-<hex>] (why work is done: a title, a
    product, a quarter, an owner, a link, a goal, milestones and risks).
    Projects live only in events; no file is created. Same locking, validation
    and commit rules as {!Write_task}; the commit message is
    [wl: project <subcommand> <id>]. *)

val add :
  Ctx.t ->
  ?session:Session.t ->
  title:string ->
  product:string ->
  ?quarter:string ->
  ?owner:string ->
  ?hlp:string ->
  ?goal:string ->
  ?milestones:string list ->
  ?risks:string list ->
  unit ->
  (string, Err.t) result
(** Create a project and return its id. The product must be in the taxonomy;
    a title already used (ignoring ASCII case) in the same product is
    [Usage]. Writes [project_created] then [set]/[add] events. *)

val set :
  Ctx.t ->
  ?session:Session.t ->
  project:string ->
  field:string ->
  value:string option ->
  unit ->
  (string * Write_task.outcome, Err.t) result
(** Set [title product quarter owner hlp goal status] of a project given by
    reference. [None] clears [quarter owner hlp goal]. A value equal to the
    current one writes nothing. Unknown project is [Not_found]. *)

val add_item :
  Ctx.t ->
  ?session:Session.t ->
  project:string ->
  field:string ->
  value:string ->
  unit ->
  (string * Write_task.outcome, Err.t) result
(** Add a [milestones] or [risks] entry; one already present writes nothing. *)

val remove_item :
  Ctx.t ->
  ?session:Session.t ->
  project:string ->
  field:string ->
  value:string ->
  unit ->
  (string, Err.t) result
(** Remove an entry; removing an absent one is [Usage]. *)
