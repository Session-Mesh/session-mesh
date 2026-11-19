(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Application of one event to a folded task (internal to {!Fold}). The
    task's [timeline], [sessions] and [blockers] are accumulated newest first;
    {!Fold} reverses them once at the end. *)

type warn = string -> unit

val of_created : Event.t -> warn -> Model.task option
(** The task a [created] event defines, or [None] (with a warning) if the
    event is invalid. *)

val reset : Model.task -> Event.t -> unit
(** [created] is the initial-value event at its own key: it resets every
    mutable field to the values it carries. *)

val apply : Model.task -> Event.t -> warn -> unit
(** Apply a validated, non-[created] event of a known type. *)

val list_add : string -> string list -> string list
(** Set insertion into a sorted list. *)

val list_remove : string -> string list -> string list
