(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** JSON views shared by the subcommands. The folder a session worked in is
    never part of a view: a repository is shown by its name only. Strings are
    cut at fixed lengths by {!Work_mcp.Work_render}. *)

type linked = {
  agent : string;
  name : string;  (** the session name *)
  repo : string option;  (** repository name, never a path *)
  branch : string option;
  last : int;  (** latest link or event of the session on these tasks *)
  linked_at : int;  (** its latest link, which names the repository and branch *)
  tasks : string list;  (** task ids, in the order met *)
  projects : string list;  (** distinct project ids of those tasks *)
}

val collect : Mesh_worklog.Model.task list -> linked list
(** The sessions linked to these tasks, one per (agent, session), the most
    recently active first (then by name). *)

val linked_json : linked -> Yojson.Safe.t
(** [name], [agent], [repo], [branch], [last_activity], [tasks] and
    [projects] (at most 20 ids each, counted in [..._omitted]). *)

val event_json : Mesh_worklog.Event.t -> Yojson.Safe.t
(** {!Work_mcp.Work_render.event_json} (an allow-list of fields: no folder)
    plus [prov] ([stated], [inferred] or [confirmed]) when the event has one. *)

val done_at : Mesh_worklog.Model.task -> int option
(** When a [done] task was last set to [done]; [None] otherwise or when the
    status came from the [created] event. *)

val task_row : Mesh_worklog.Model.world -> Mesh_worklog.Model.task -> Yojson.Safe.t
(** The compact task of lists: [id], [title], [status], [priority], [product],
    [project], [project_title], [track], [due], [owner], [last_activity],
    [last_note], plus [created], [eta], [size], [done_at], [blockers] (open),
    [blocked_by] (ids, at most 20), [dependency_open] (a [blocked_by] task is
    still open) and [sessions] (names of the linked sessions, at most 10). *)

val project_title : Mesh_worklog.Model.world -> Mesh_worklog.Model.task -> string option
