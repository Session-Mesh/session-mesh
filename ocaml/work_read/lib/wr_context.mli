(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [work-read context --format F]: the [project_context] consumer of the agent
    hook model (docs/agent-hooks.md). An agent's session-start hook runs it;
    what it prints is added to the agent's context.

    It reads the tracker and never writes: no lock, no commit, no repository
    creation. It never delays the agent beyond {!cap_seconds}: a real-time timer
    ends the process (exit 0, nothing printed) when the read takes longer. It
    never fails visibly: no Mesh session ([MESH_SESSION] unset), no repository,
    an unreadable one, an error or an exception all end with exit 0 and nothing
    on standard output or standard error.

    What it prints carries no text of the tracker: only task identifiers
    (checked against the [T-<hex>] form), counts and a fixed sentence, since
    tracker text is written by other agents and would otherwise reach this
    agent's context as trusted input. Nothing is printed when the session has no
    linked task, no task for its folder and no question. The Mesh session token
    is removed from the environment before anything else. *)

type format =
  | Claude
      (** Claude Code [SessionStart]: [hookSpecificOutput.additionalContext] *)
  | Vibe
      (** Mistral Vibe [session_start]:
          [hook_specific_output.additional_context] *)
  | Text
      (** the sentence alone, one line (an agent that adds a hook's stdout) *)
  | Json  (** the agent-independent document, for tests and future adapters *)

val formats : (string * format) list
(** The names accepted by [--format]. *)

val cap_seconds : float
(** 1.5 s. *)

type summary = {
  session_tasks : string list;
      (** tasks linked to this session, at most {!max_ids} *)
  session_tasks_total : int;
  folder_tasks : string list;
      (** tasks linked to this folder or branch, at most {!max_ids} *)
  folder_tasks_total : int;
  open_questions : int;  (** asked by this session, unanswered *)
  answered_questions : int;
      (** asked by this session, answered in the last 14 days *)
}

val max_ids : int

val sentence : summary -> string option
(** The fixed sentence, or [None] when there is nothing to say. *)

val render : format -> summary -> string option
(** The line to print for an agent, or [None]. *)

val summarise : getenv:(string -> string option) -> unit -> summary option
(** Read the tracker; [None] on any failure or without a Mesh session. *)

val main : string list -> int
(** The arguments after [context]; always 0. *)
