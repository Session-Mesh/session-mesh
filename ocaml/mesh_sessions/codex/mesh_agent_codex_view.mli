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
      rule that needs them then gives nothing). Two exceptions, where it
      holds none: it exited ([Not_found]), or its owner
      ({!Mesh_agent_round.owner}) is positively another user, since only this
      user's Codex write in this user's [~/.codex]. [Denied] alone is not
      enough: a non-dumpable process of this user is [Denied] too. An owner
      that cannot be read (macOS does not read it yet) counts as this user;
    - a Codex's own helpers are not "another" Codex. *)

type t

val read : Mesh_agent_round.t -> t
(** Reads the command line, folder and open files of each Codex process. *)

val round : t -> Mesh_agent_round.t

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
    incomplete. A conversation whose id is not a string ([None]) is named
    only by a launch whose [resume] id cannot be read. (Python calls
    [str.lower] on that missing id and fails as soon as another top-level
    Codex runs.) *)
