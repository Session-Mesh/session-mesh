(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The deterministic fold of events into tasks and projects. Nothing here
    performs I/O.

    Events are ordered by (ts, host, file, line); a later key wins. [created]
    and [project_created] are initial-value events at their own key; the
    earliest valid one per id defines the entity and later duplicates are
    reported as [DUPLICATE_ID]. Unknown event types and fields, and invalid
    values, are ignored with a warning, never fatal.

    Types owned by capabilities this library does not implement are skipped
    silently: proposal events ([proposed], [accepted], [rejected], [amended]),
    events on [Q-] or [product:] ids, and [linear] list fields. *)

val fold : Event.t list -> (string -> unit) -> Model.world
(** [fold events warn]. [events] may be in any order; [warn] receives one
    message per ignored item. *)
