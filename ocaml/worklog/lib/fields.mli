(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Field registry: enumerations, limits and value validation shared by the
    fold (reading) and the writer. Validators return the reason a value is
    refused, or [None] when it is acceptable. Values are JSON, as stored in
    events. *)

val statuses : string list
val priorities : string list
val blocker_kinds : string list
val task_kinds : string list
(** [decision learning risk metric mentoring shipped]. *)

val prov_values : string list
val sizes : string list
val origins : string list
val project_statuses : string list
val task_scalars : string list
val project_scalars : string list
val task_list_fields : string list
(** [tags links blocked_by also]. *)

val project_list_fields : string list
(** [milestones risks]. *)

val task_scalar_error : string -> Yojson.Safe.t -> string option
val project_scalar_error : string -> Yojson.Safe.t -> string option
val task_item_error : string -> Yojson.Safe.t -> string option
(** For [tags], [links], [blocked_by] and [also]. *)

val project_item_error : string -> Yojson.Safe.t -> string option
val kind_error : kind:string -> text:Yojson.Safe.t option -> date:Yojson.Safe.t option -> string option
(** Payload check of a [decision]/.../[shipped] event. *)

val valid_task_id : string -> bool
(** [T-] and at least four lowercase hex digits. *)

val valid_project_id : string -> bool
(** [P-] and at least four lowercase hex digits. *)

val valid_blocker_id : string -> bool
(** [B-] and at least one lowercase hex digit. *)

val valid_quarter : string -> bool
