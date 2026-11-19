(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** What the Codex identity rules need to know about every Codex process of
    one round's process table, read once ([discover._CodexView]): the folder
    of each top-level Codex, the words each was launched with, and the
    rollouts each Codex holds open.

    A Codex process is one named [codex] by the kernel; a top-level one is not
    the child of another [codex] (a helper). Fail-closed rules, as Python:

    - an incomplete process table counts at least two Codex in any folder and
      lets any conversation be named by another Codex;
    - a Codex whose open files cannot be read holds unknown rollouts (every
      rule that needs them then gives nothing), unless it exited
      ([Not_found]) or belongs to another user ([Denied]): it then holds none,
      since only this user's Codex write in this user's [~/.codex];
    - a Codex's own helpers are not "another" Codex. *)

type t

val read : Mesh_agent_round.t -> t
(** Reads the command line, folder and open files of each Codex process. *)

val round : t -> Mesh_agent_round.t

val codex_pids : t -> int list
(** Every Codex process, by ascending pid. *)

val top_level : t -> int -> bool

val open_rollouts : t -> int -> string list option
(** The rollouts ([.../.codex/sessions/...rollout-...]) this process holds
    open, read now if it is not a Codex process of the view; [None] when its
    open files cannot be read. *)

val count : t -> string option -> int
(** [discover._codex_count]: the top-level Codex whose folder is this one
    ([None]: unreadable); at least 2 when the table is incomplete. *)

val held_by_others : t -> int -> (string, unit) Hashtbl.t option
(** The rollouts Codex processes other than this one and its descendants hold
    open; [None] when one of them is unknown. *)

val named_by_others : t -> int -> string option -> bool
(** Whether another top-level Codex may have been launched on this
    conversation ({!Mesh_agent_codex_argv.may_name}); [true] when the table is
    incomplete or the id is not a string ([None]). *)
