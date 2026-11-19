(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t = { device : int; inode : int; size : int; mtime_ns : int; mtime : float }

external lstat_regular : string -> t option = "mesh_agent_codex_lstat_regular"
