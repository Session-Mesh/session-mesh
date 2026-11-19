(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The program [work-write]: the owner-only writer behind the web server's
    owner sign-in. Its one form is [work-write --request], the request
    ({!Ww_request}) on standard input; it prints one JSON line.

    It decides nothing about authority: the web server runs it only for the
    owner's signed-in browser. As a guard against an agent running it from
    its own shell, it refuses to run when the environment names an agent
    session ({!session_variables}); the server starts it with [HOME] and
    [WL_HOME] only. That guard is not a security boundary: any process of the
    same user can write the log directly. *)

val session_variables : string list
(** [MESH_SESSION], [MESH_SESSION_TOKEN], [WL_SESSION], [WL_AGENT],
    [CLAUDE_CODE_SESSION_ID], [OPENCODE_SESSION_ID], [CODEX_THREAD_ID]: a
    non-empty one makes the program refuse ([agent_session], exit 9). *)

val run : ?getenv:(string -> string option) -> Ww_request.t -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
(** Execute a parsed request: [answer] records the owner's answer with
    {!Work_mcp.Work_questions.answer_once} [~owner_web:true ~by:"owner"].
    The document is [{schema, command: "answer", id, state: "answered",
    owner_verified: true, duplicate}]; another owner-authenticated answer
    already there is the error [already_answered]. *)

val exit_code : Work_mcp.Work_err.t -> int
(** The codes of work-read ([invalid_input] 2, [not_found] 3,
    [malformed_data] 4, [lock_timeout] 5, [repository] 6, [internal] 7,
    other 1), plus [already_answered] 8 and [agent_session] 9. *)

val main : string list -> int
(** The arguments after the program name; the exit code. Never raises: any
    exception is an [internal] error (exit 7). *)
