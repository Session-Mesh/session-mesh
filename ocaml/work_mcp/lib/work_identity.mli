(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Who is calling: the agent kind and session name the server passes to the
    worklog library as [agent] and [session].

    The session name is [MESH_SESSION], the name the Mesh gives the session;
    a value the library refuses is ignored and the session is then unknown: it
    does not fall back to [WL_SESSION] or [CLAUDE_CODE_SESSION_ID]. Without
    [MESH_SESSION] the library's own variables apply. The agent kind comes from
    [WL_AGENT] or the markers an agent leaves in its environment
    ([CLAUDECODE], [OPENCODE_SESSION_ID], [CODEX_THREAD_ID], ...; never a
    configuration directory such as [CODEX_HOME]), else
    [agent]. Without any of them there is no identity and writes carry none.
    The Mesh session token is never read: no tool, log or output can carry
    it. *)

type t = {
  cwd : string;  (** real path of the server's working directory; stored in the data
                     repository by the library, never returned by a tool *)
  session : Mesh_worklog.Session.t option;
  problem : string option;
      (** why the identity could not be resolved (an invalid [MESH_SESSION] or
          [WL_AGENT], ...); [None] when it was, or when none was asked for *)
}

val warn_if_unresolved : t -> unit
(** For a write: add a [write_warnings] entry when the environment gave an
    identity that could not be resolved, so that the caller knows the write
    carries no session and no agent. *)

val of_env : ?getenv:(string -> string option) -> unit -> t
(** Resolve from an environment (tests). *)

val current : unit -> t
(** The identity of this process, resolved once. *)

val session_id : t -> string option
val has_session_id : t -> bool

val scrub_environment : unit -> unit
(** Empty [MESH_SESSION_TOKEN] in this process, so that the [git] processes
    the worklog library starts do not inherit it. Called at start. *)
