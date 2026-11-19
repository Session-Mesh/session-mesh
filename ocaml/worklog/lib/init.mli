(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Creating a minimal valid data repository. *)

val init :
  root:string ->
  ?category:string ->
  ?category_name:string ->
  ?product:string ->
  ?git:bool ->
  unit ->
  (unit, Err.t) result
(** Create [root] (and its parents) holding [taxonomy.yaml] with one category
    (key [category], default [main]; display name [category_name], default
    [Main]) and one product ([product], default [general]), empty [tasks/] and
    [events/] directories, and a [.gitignore] for the lock file. Unless
    [git] is [false], run [git init] and make one local commit ([wl: init]);
    no remote is configured. Refuses ([Usage]) to touch a directory that
    already holds a [taxonomy.yaml]; existing files are never overwritten. *)
