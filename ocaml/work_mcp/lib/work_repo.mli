(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The data repository of this process: the library's discovery ([WL_HOME],
    else [~/worklog-data], else the older [~/worklog]), created at first use
    and never overwritten. *)

val context : ?getenv:(string -> string option) -> unit -> (Mesh_worklog.Ctx.t, Work_err.t) result
(** Discover the repository. When there is none, and the place the library
    would look first ([WL_HOME] or [~/worklog-data]) does not exist or is an
    empty directory (a missing one only when its parent directory exists: a
    misspelt [WL_HOME] does not create a chain of directories), create it with the library's [init] (a minimal taxonomy,
    empty [tasks/] and [events/], a local git repository without remote) and
    use it. A directory holding anything else, or two valid default
    repositories, is an error and nothing is written. *)

val reset_warnings : unit -> unit
(** Forget the non-fatal problems of earlier writes (a failed commit, ...). *)

val warn : string -> unit
val take_warnings : unit -> string list
(** The problems reported since {!reset_warnings}, at most 20, oldest first. *)
