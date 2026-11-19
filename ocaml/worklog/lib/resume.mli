(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The start-of-session briefing: open tasks sorted into sections. Each task
    appears once, in the first section that claims it, in the precedence
    HERE, BLOCKED/WAITING, DUE, STALE, IN PROGRESS (then TODO with
    [show_all]); sections are displayed in the order HERE, IN PROGRESS,
    BLOCKED/WAITING, STALE, DUE. Dates are UTC. *)

type where = {
  host : string;
  cwd : string;  (** real path of the caller's directory *)
  home : string option;  (** the caller's home directory, never matched as a linked folder *)
  session : string option;
  repo : string option;  (** git top level of [cwd] *)
  branch : string option;
}
(** Where the caller is, for the HERE tiers: (1) a link to the caller's
    session; (2) on the same host, a link with the same repo and branch; (3) on
    the same host, a link whose folder is [cwd] or an ancestor, other than [/]
    and the home directory. *)

type row = {
  task : Model.task;
  days : int;  (** whole days since the latest event *)
  last_note : string option;  (** first line of the latest note, at most 80 characters *)
  tier : int option;  (** HERE tier, 1 is best *)
  open_blockers : Model.blocker list;
  unblock : bool;
      (** the task has [blocked_by] tasks and all are [done] or [dropped]:
          worth asking whether to unblock it *)
  project_title : string option;
}

type report = {
  here : row list;  (** at most 5 *)
  in_progress : row list;
  blocked : row list;
  stale : row list;
  due : row list;  (** due within 7 days or overdue *)
  todo : row list;  (** only with [show_all] *)
}

val build :
  Model.world ->
  now:int ->
  ?where:where ->
  ?stale_days:int ->
  ?show_all:bool ->
  ?keep:(Model.task -> bool) ->
  unit ->
  report
(** [stale_days] defaults to 5, [show_all] to false (no TODO section). [keep]
    narrows the tasks considered (filters). Without [where] the HERE section is
    empty. When some task of the view has a project or a track, every section
    is ordered by (product, project, track) before its usual key. *)

val here_cap : int
val due_days : int
