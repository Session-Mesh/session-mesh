(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Where a question of [resume] stands in the tracker, so that the Projects
    view can classify the open questions without reading each task: the
    [context] object added to a question about a known task or project. *)

val fields : Wr_load.t -> Work_mcp.Work_questions.question -> (string * Yojson.Safe.t) list
(** About a task: [task_title], [project] and [project_title] (when the task
    is in a project), [product] and [category]. About a project: [project],
    [project_title], [product] and [category]. Otherwise (about nothing, or an
    unknown id): nothing. [category] is the key of the product's category in
    the taxonomy, else the category recorded with the task or project. Titles
    are cut at 200 bytes. *)

val add : Wr_load.t -> Work_mcp.Work_questions.question -> Yojson.Safe.t -> Yojson.Safe.t
(** [add loaded q json] appends [("context", `Assoc (fields loaded q))] to the
    question object [json], unless the fields are empty. *)
