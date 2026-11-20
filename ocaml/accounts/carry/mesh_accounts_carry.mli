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
      [projects/<project>/<id>/] (subagents, tool results), where [<project>] is
      the one folder of [projects/] that holds [<id>.jsonl];
    - Codex: the one
      [sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl], [<id>] a
      whole UUID matched exactly, in folders named [YYYY], [MM] and [DD]
      (digits).

    {b Codex: only the rollout file is copied.} Codex also keeps
    [state_5.sqlite], [session_index.jsonl] and [thread_history_1.sqlite], which
    are not copied. Whether [codex resume <id>] under the other [CODEX_HOME]
    works with the rollout alone is {b not verified}: it is to be tried on
    throwaway accounts before a caller carries Codex conversations.

    Nothing else is copied: not the login files, not the settings, not the
    project's memory or its other conversations. A symbolic link, a file that is
    not regular, not the operator's or has another name (a hard link), a file or
    folder that group or others can write, or a file named as a login file
    ({!is_login_file}) anywhere in what would be copied refuses the whole carry.
    A carry's own temporary files in the source are left out.

    Bounds ({!default_limits}): at most 5000 files and 2 GiB in all
    ([conversation_too_large]); the target's file system must keep 512 MiB free
    after the copy ([target_no_space]), checked before anything is written. The
    free space is checked, not reserved: carries of different conversations
    running at the same time, or any other writer, can still use it up. A full
    disk then fails the carry, which is undone.

    A file already in the target is left when identical, replaced when it is a
    prefix of the source (the conversation went on since an earlier carry), and
    refuses the whole carry otherwise: a different copy is never overwritten,
    nor one that group or others can write. A read that fails while comparing is
    a [carry_failed] refusal. Every file is written to a temporary file (mode
    0600, folders created 0700), then all are put in place; a failure at any
    step (a full disk, a failed close or rename) removes what was written and
    puts a replaced copy back, so the target is as it was. When a replaced copy
    cannot be put back, it is kept as [.<name>.carry-old-<16 hex>] next to its
    place and the refusal [carry_restore_failed] names it; when a new copy
    cannot be removed, the refusal [carry_rollback_incomplete] names it.

    Two carries of the same conversation into the same folder never overlap:
    each holds, without waiting, an exclusive lock (fcntl, between processes) on
    [.mesh-carry.lock] ({!lock_name}, 0600) in the target folder, chosen by the
    conversation id taken without case; the second is refused with
    [carry_in_progress]. The lock file stays in the folder.

    A carry killed half way can leave [.<name>.carry-new-<16 hex>] and
    [.<name>.carry-old-<16 hex>] next to the files it was writing. The next
    carry of that conversation into that folder removes the new ones, under the
    lock, before planning; an old copy goes back in place first when the file
    itself is missing, and the other old copies are removed only once that carry
    succeeds. No other file is removed.

    The caller stops the agent before the carry: a transcript still being
    written could be caught half way, and an agent writing in the target between
    the plan and the copy would lose its writes. *)

type kind = Claude | Codex

type error = { code : string; message : string }
(** [code] is one of [conversation_unknown] (not a valid id),
    [conversation_not_found], [conversation_ambiguous], [conversation_diverged],
    [conversation_too_large], [unsafe_entry], [account_same],
    [account_folder_refused], [account_unknown], [account_no_agent],
    [accounts_refused], [target_no_space], [carry_in_progress],
    [carry_restore_failed], [carry_rollback_incomplete], [carry_failed].
    [message] names paths relative to the account folders only: an absolute path
    is replaced by [<path>], a control character by [?], and an unknown alias is
    not repeated. *)

type limits = { max_files : int; max_bytes : int; free_margin : int }

val default_limits : limits
(** [max_files] 5000, [max_bytes] 2 GiB (2147483648), [free_margin] 512 MiB
    (536870912): generous for a conversation, with a margin left to the other
    writers of the disk. *)

type outcome = {
  files : int;  (** Files of the conversation. *)
  copied : int;  (** Written where there was none. *)
  replaced : int;  (** Older copies replaced. *)
  unchanged : int;  (** Already identical. *)
  bytes : int;  (** Bytes written. *)
}

type io = {
  write : Unix.file_descr -> bytes -> int -> int -> int;
  read : Unix.file_descr -> bytes -> int -> int -> int;
      (** Of the source, and of a target copy compared with it. *)
  unlink : string -> unit;  (** Of a new copy, when a carry is undone. *)
  rename : string -> string -> unit;
  close : Unix.file_descr -> unit;  (** Of a file being written. *)
  free_bytes : string -> int option;
      (** Bytes available on the file system of a path (statvfs). *)
}
(** The operations a carry can fail in once it has started; tests replace them
    to make a step fail. *)

val default_io : io
val kind_of_string : string -> kind option

val is_login_file : string -> bool
(** A file name never carried, ignoring ASCII case: [.credentials.json],
    [credentials.json], [auth.json], [config.toml], [.env], [.env.*],
    [.claude.json*] (with its backups), [.credentials*], [settings*.json],
    [id_rsa*], [id_dsa*], [id_ecdsa*], [id_ed25519*], [*.pem], [*.key]. A safety
    net, not a boundary: both accounts belong to the same user, and an agent can
    already paste its credentials into a transcript. *)

val lock_name : string
(** [.mesh-carry.lock]. *)

val valid_conversation_id : string -> bool
(** [[0-9A-Za-z][0-9A-Za-z_-]{7,63}]: the conversation ids Mesh resumes. For
    Codex the id must also be a whole UUID. *)

val account_folder :
  uid:int ->
  getenv:(string -> string option) ->
  file:string ->
  kind:kind ->
  create:bool ->
  string ->
  (string, error) result
(** The folder of an account for an agent: for [default], [CLAUDE_CONFIG_DIR] or
    [CODEX_HOME] when set to an absolute path, else [$HOME/.claude] or
    [$HOME/.codex]; for an alias, its folder in [file] after
    {!Mesh_accounts.load}. The folder passes {!Mesh_accounts.check_directory};
    with [create] a missing one is created as {!Mesh_accounts.prepare_directory}
    does. *)

val carry :
  ?io:io ->
  ?limits:limits ->
  uid:int ->
  kind:kind ->
  conversation:string ->
  source:string ->
  target:string ->
  unit ->
  (outcome, error) result
(** Both folders must exist and pass {!Mesh_accounts.check_directory}, and
    differ. *)

val carry_accounts :
  ?io:io ->
  ?limits:limits ->
  uid:int ->
  getenv:(string -> string option) ->
  file:string ->
  kind:kind ->
  conversation:string ->
  from_account:string ->
  to_account:string ->
  unit ->
  (outcome, error) result
(** {!carry} between two accounts found by {!account_folder}. The source folder
    must exist before a missing target folder is created; a target folder this
    run created is removed again (with its lock file) when the carry is refused
    and no other carry holds its lock. *)

val outcome_to_json : outcome -> Yojson.Safe.t
