(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [ids]: every task, project and question id of the tracker with a short
    title, for the references of the terminal (an id printed in a terminal is a
    link only when it is listed here).

    [tasks[] {id, title}] and [projects[] {id, title}], done and dropped ones
    included, most recent activity first;
    [questions[] {id, title, about?, project?}], answered ones included, newest
    first, where [title] is the start of the question's text and [project] the
    project it is about, directly or through its task. Nothing else: no status,
    note, session, folder or timeline. Titles are cut at {!max_title} bytes. *)

val max_tasks : int
(** 4000; the others are counted in [tasks_omitted]. *)

val max_projects : int
(** 1000. *)

val max_questions : int
(** 1000. *)

val max_title : int
(** 100. *)

val run : Wr_load.t -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
