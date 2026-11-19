(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The agent session on whose behalf a write is made. The caller supplies
    it; every field is optional context except the agent. *)

type t = {
  agent : string;  (** [[a-z0-9_-]+] *)
  session : string option;  (** the full session id, [[A-Za-z0-9_.:][A-Za-z0-9_.:-]*] *)
  cwd : string option;  (** real path of the session's folder, for [session_linked] *)
  repo : string option;  (** git top level of [cwd] *)
  branch : string option;  (** current branch, [None] when detached *)
}

val make :
  agent:string ->
  ?session:string ->
  ?cwd:string ->
  ?repo:string ->
  ?branch:string ->
  unit ->
  (t, Err.t) result
(** Validate the formats of agent and session ([Usage] otherwise). *)

val resolve :
  ?getenv:(string -> string option) ->
  ?agent:string ->
  ?session:string ->
  ?cwd:string ->
  unit ->
  (t option, Err.t) result
(** The session of a caller by [wl]'s precedence: session from the argument,
    [WL_SESSION], [CLAUDE_CODE_SESSION_ID], [OPENCODE_SESSION_ID]; agent from
    the argument, [WL_AGENT], or the agent the winning variable implies
    ([claude], [opencode]). Empty values count as unset. A session without a
    resolvable agent is [Usage]; nothing resolvable is [Ok None]. When [cwd]
    is given, it is validated first (absolute, one line, at most 4096
    characters: [Usage] otherwise, before any git call), then [repo] and
    [branch] are read from git. Never raises. *)
