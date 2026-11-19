(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [projects] (the list with counts, and the tasks without a project per
    product) and [project] (one project with the tasks grouped for the four
    views). *)

val max_projects : int
(** 200 projects, and 200 product entries without project. *)

val max_tasks : int
(** 200 tasks in a project document. *)

val max_edges : int
(** 300 dependency edges. *)

val column_names : string list
(** The board columns, in order: [todo], [in_progress], [blocked], [done],
    [other]. *)

val column_of : Mesh_worklog.Model.task -> string
(** The one column of a task: [done] for [done] and [dropped]; else
    [blocked] when {!Wr_stats.is_blocked}; else [in_progress], [todo]
    ([inbox], [todo]) by status; [other] for any other status (a hand-edited
    file). *)

val list : Wr_load.t -> product:string option -> all:bool -> (Yojson.Safe.t, Work_mcp.Work_err.t) result

val detail : Wr_load.t -> string -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
