(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t = { home : string }

let of_home home = { home }

let of_environment getenv =
  match getenv "HOME" with
  | Some home when home <> "" && not (Filename.is_relative home) -> Ok (of_home home)
  | _ -> Error "HOME is not set to an absolute path"

let home roots = roots.home
let claude roots = Filename.concat roots.home ".claude"
let codex roots = Filename.concat roots.home ".codex"
