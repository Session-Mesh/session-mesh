(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Shared checks of the writers. They raise {!Err.E}, which {!Txn.run}
    turns into an [Error]. *)

val check : string option -> unit
(** Raise a [Usage] error carrying the reason, if any. *)

val taxonomy : Ctx.t -> Taxonomy.t
(** The repository's taxonomy ([Repo] if missing, [Usage] if invalid). *)

val product_category : Ctx.t -> string -> string
(** The category of a product; an unknown one is [Usage]. *)

val task : Txn.t -> string -> Model.task
(** Resolve a task reference in the state read under the lock. *)

val project_id : Txn.t -> string -> string
(** Resolve a project reference in the state read under the lock. *)

val json_of_option : string option -> Yojson.Safe.t
(** [None] is [`Null]. *)

val text : what:string -> string -> string
(** Event text: validated with {!Textcheck.body_text_error}; returned as is. *)

val prov : string option -> (string * Yojson.Safe.t) list
(** The [prov] field to add to an event: nothing for [None] or [stated],
    [Usage] for an unknown value. *)

val today : Txn.t -> string
(** The UTC date of the transaction's clock. *)
