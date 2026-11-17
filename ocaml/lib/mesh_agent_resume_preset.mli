(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t
type entry

val load :
  ?agent_after_drop:bool ->
  path:string ->
  expected_sha256:string ->
  hold_directory:(string -> Eio.Fs.dir_ty Eio.Path.t) ->
  unit ->
  t
(** Trusted startup only: private runner-owned file and admitted exact bytes,
    fixed Claude/Codex executable/entrypoint configuration. Default mode holds
    runner-private CWDs. [agent_after_drop] keeps only a validated absolute CWD
    string: the isolated PTY launcher must verify ownership, canonical path and
    accessibility after dropping to the agent UID. Never invoke this loader from
    client requests. Malformed custody refuses. *)

val find : t -> string -> entry option
val directory : entry -> Eio.Fs.dir_ty Eio.Path.t option
val cwd : entry -> string
val arguments : entry -> string list
val environment : entry -> string array

val launcher_files : entry -> string list
(** Exact startup-pinned executable followed by zero or more script paths. *)

val revalidate : entry -> unit
(** Rechecks held directory when present and startup-pinned executable/script
    identity and digest. Agent-owned CWD checks are deferred to the isolated
    post-drop launcher. A mismatch refuses, never adopts new bytes. *)
