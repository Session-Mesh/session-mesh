(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Application of one event to a folded project entity (internal to {!Fold}). *)

type warn = string -> unit

val of_created : Event.t -> warn -> Model.project option
(** The project a [project_created] event defines, or [None] with a warning. *)

val reset : Model.project -> Event.t -> unit
(** [project_created] is the initial-value event at its own key. *)

val apply : Model.project -> Event.t -> warn -> unit
(** Apply a [set], [add] or [remove] event keyed on the project. *)
