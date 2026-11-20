(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Carry one conversation from an account's folder to another's, so that the
    agent can resume it under the other account.

    What is copied, at the same place relative to the folder:
    - Claude: [projects/<project>/<id>.jsonl] and the folder
      [projects/<project>/<id>/] (subagents, tool results), where [<project>]
      is the one folder of [projects/] that holds [<id>.jsonl];
    - Codex: the one [sessions/YYYY/MM/DD/rollout-*-<id>.jsonl].

    Nothing else is: not the login files, not the settings, not the project's
    memory or its other conversations. A symbolic link, a file that is not
    regular or not the operator's, or a file named as a login file
    ({!login_files}) anywhere in what would be copied refuses the whole carry.

    A file already in the target is left when identical, replaced when it is
    a prefix of the source (the conversation went on since an earlier carry),
    and refuses the whole carry otherwise: a different copy is never
    overwritten. Every file is written to a temporary file (mode 0600, folders
    created 0700), then all are put in place; a failure at any step removes
    what was written and puts a replaced copy back, so the target is as it was.

    The caller stops the agent before the carry: a transcript still being
    written could be caught half way. *)

type kind = Claude | Codex

type error = { code : string; message : string }
(** [code] is one of [conversation_unknown] (not a valid id),
    [conversation_not_found], [conversation_ambiguous],
    [conversation_diverged], [unsafe_entry], [account_same],
    [account_folder_refused], [account_unknown], [account_no_agent],
    [accounts_refused], [carry_failed]. [message] names paths relative to the
    account folders only. *)

type outcome = {
  files : int;  (** Files of the conversation. *)
  copied : int;  (** Written where there was none. *)
  replaced : int;  (** Older copies replaced. *)
  unchanged : int;  (** Already identical. *)
  bytes : int;  (** Bytes written. *)
}

type io = {
  write : Unix.file_descr -> bytes -> int -> int -> int;
  rename : string -> string -> unit;
}
(** The two operations a carry can fail in after it has started writing; tests
    replace them to make a step fail. *)

val default_io : io
val kind_of_string : string -> kind option

val login_files : string list
(** [.credentials.json], [.claude.json], [auth.json]. *)

val valid_conversation_id : string -> bool
(** [[0-9A-Za-z][0-9A-Za-z_-]{7,63}]: the conversation ids Mesh resumes. *)

val account_folder :
  uid:int ->
  getenv:(string -> string option) ->
  file:string ->
  kind:kind ->
  create:bool ->
  string ->
  (string, error) result
(** The folder of an account for an agent: for [default], [CLAUDE_CONFIG_DIR]
    or [CODEX_HOME] when set to an absolute path, else [$HOME/.claude] or
    [$HOME/.codex]; for an alias, its folder in [file] after
    {!Mesh_accounts.load}. The folder passes {!Mesh_accounts.check_directory};
    with [create] a missing one is created as {!Mesh_accounts.prepare_directory}
    does. *)

val carry :
  ?io:io ->
  uid:int ->
  kind:kind ->
  conversation:string ->
  source:string ->
  target:string ->
  unit ->
  (outcome, error) result
(** Both folders must exist and pass {!Mesh_accounts.check_directory}, and
    differ. *)

val outcome_to_json : outcome -> Yojson.Safe.t
