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
    are not copied and are not needed: with codex-cli 0.170.0,
    [codex resume <id>] and [codex exec resume <id>] under a [CODEX_HOME]
    holding only its [config.toml] and the carried rollout send the earlier
    turns to the model. Claude resumes from [<id>.jsonl] alone; the [<id>/]
    folder keeps the subagents' transcripts, and a large tool output stays named
    in the transcript by its path in the source folder.

    Neither agent's folder trust is carried: the first launch of an account in a
    working folder it never opened asks whether to trust that folder (Claude:
    any folder, the answer kept in the account's [.claude.json]; Codex: a git
    repository, kept in its [config.toml]). The operator answers it once per
    account and folder; a carry never writes those files.

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
    disk then fails the carry; incomplete rollback is reported.

    A target file is left when identical and replaced only when it is a prefix
    of the source; divergent copies are refused. Installations use exclusive
    creation. Replaced files are moved without overwriting an existing name to
    [.<name>.carry-saved-<16 hex>] and retained, including after success, so a
    process holding the old inode can still write to it. [recovery_copies]
    reports retained copies. Later writes to a recovery copy are not merged
    into the active conversation; the owner must review them. If an exclusive
    move is unsupported, the carry refuses rather than falling back to an
    overwriting move.

    A failed carry removes staged files when safe. Installed files and recovery
    copies may remain when their custody cannot be proven: the refusal
    [carry_rollback_incomplete] or [carry_restore_failed] reports the uncertainty.
    New directories without proven cleanup custody are also retained.

    Two carries of the same conversation into the same folder never overlap:
    each holds, without waiting, an exclusive lock (fcntl, between processes) on
    [.mesh-carry.lock] ({!lock_name}, 0600) in the target folder, chosen by the
    conversation id taken without case; the second is refused with
    [carry_in_progress]. The lock file stays in the folder.

    {b The lock excludes processes, not callers inside one process.} POSIX fcntl
    locks belong to the process: two carries running in the same process (threads,
    domains, Lwt) do not exclude each other, and closing any descriptor of the
    lock file drops all of that process's locks. A caller that runs carries
    in its own process (the web server) must therefore run one process per carry
    (call [mesh-platform accounts carry]) or add its own in-process mutex. Nothing
    is guaranteed on NFS, FUSE or SMB: locking may fail there (a [carry_failed]
    refusal) or exclude nothing between machines.

    An interrupted carry can leave [.<name>.carry-new-<16 hex>] and
    [.<name>.carry-saved-<16 hex>]. A later carry removes eligible staged files,
    retains recovery copies and reports their count. Historical
    [.<name>.carry-old-<16 hex>] artifacts are never moved or removed
    automatically: their presence refuses the carry for owner review.

    The caller stops the source agent before the carry. Other target writers
    are not excluded by the carry lock; saved copies preserve the old inode but
    do not automatically reconcile writes made after the copy.

    A transcript or rollout whose last line was cut (an agent killed while
    writing it) is copied as it is, byte for byte: the carry neither completes
    nor drops that line, so the other account reads exactly what this one
    would, and the source is never changed. Once the source holds the whole
    line, a later carry replaces the cut copy, of which it is a prefix. *)

type kind = Claude | Codex

type error = { code : string; message : string }
(** [code] is one of [conversation_unknown] (not a valid id),
    [conversation_not_found], [conversation_ambiguous], [conversation_diverged],
    [conversation_too_large], [unsafe_entry], [account_same],
    [account_folder_refused], [account_unknown], [account_no_agent],
    [accounts_refused], [target_no_space], [carry_in_progress],
    [carry_restore_failed], [carry_rollback_incomplete], [carry_failed].
    A caller can retry [carry_in_progress] (another carry holds the lock) and
    [target_no_space] (once space is freed) as is; [carry_restore_failed] and
    [carry_rollback_incomplete] report a file or folder left in place and need someone to
    step in; the others refuse the request as given. The CLI adds
    [agent_unsupported] (an agent other than claude or codex) and exits 2 on a
    usage error (wrong number of arguments), 1 on any refusal, 0 on success.
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
  recovery_copies : int;  (** Retained recovery copies relevant to these files. *)
}

type io = {
  write : Unix.file_descr -> bytes -> int -> int -> int;
  read : Unix.file_descr -> bytes -> int -> int -> int;
      (** Of the source, and of a target copy compared with it. *)
  unlink : string -> unit;  (** Of a new copy, when a carry is undone. *)
  rename : string -> string -> unit;
  rename_noreplace : string -> string -> unit;
  link : string -> string -> unit;
  close : Unix.file_descr -> unit;  (** Of a file being written. *)
  free_bytes : string -> int option;
      (** Bytes available on the file system of a path (statvfs). *)
}
(** The operations a carry can fail in once it has started; tests replace them
    to make a step fail. *)

val rename_noreplace : string -> string -> unit
(** Atomically move without replacing the destination; raises [Unix.Unix_error]
    when unsupported or when the destination exists. *)

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
  ?expected_contexts:(string * string) ->
  ?legacy_only:bool ->
  uid:int ->
  getenv:(string -> string option) ->
  file:string ->
  kind:kind ->
  conversation:string ->
  from_account:string ->
  to_account:string ->
  unit ->
  (outcome, error) result
(** {!carry} between two accounts found by {!account_folder}. When supplied,
    [legacy_only] refuses native named entries from the same loaded snapshot,
    before any target is prepared. It cannot be combined with [expected_contexts].
    [expected_contexts] binds source and target revisions to the same loaded
    native snapshot before any target is created; legacy entries are refused.
    A default entry uses SHA-256 of [mesh-default-v1], NUL, the backend,
    NUL, and its resolved absolute folder. Callers must independently establish
    the running agent's effective folder before supplying that revision.
    A later registry edit
    does not change the snapshot and must be handled by the caller. The source folder
    must exist before a missing target folder is created. If the carry is refused
    without proof that it can remove a newly made target, the folder and any
    lock file remain in place; [carry_rollback_incomplete] reports the retained
    target. *)

val outcome_to_json : outcome -> Yojson.Safe.t

val carry_pi_accounts :
  uid:int ->
  file:string ->
  conversation:string ->
  from_account:string ->
  to_account:string ->
  source_revision:string ->
  target_revision:string ->
  (outcome, error) result
(** Transfer a conversation between two named native Pi histories whose
    revisions match one registry snapshot. The caller must first stop or
    checkpoint the source writer and hold its session relaunch fence. *)

val exec_opencode_profile :
  uid:int -> file:string -> profile:string -> revision:string ->
  executable:string -> args:string list -> ('a, error) result
(** Replace the current process while retaining a shared lock on the selected
    profile data. The lock survives exec and conflicts with a native carry. *)

val carry_opencode_accounts :
  uid:int ->
  file:string ->
  binary:string ->
  home:string ->
  workspace:string ->
  source_runtime:string ->
  target_runtime:string ->
  conversation:string ->
  from_account:string ->
  to_account:string ->
  source_revision:string ->
  target_revision:string ->
  logical_id:string ->
  epoch:int ->
  receipt_directory:string ->
  operation_id:string ->
  (Mesh_opencode_transfer.lineage, error) result
(** Transfer between named OpenCode profiles resolved from one revision-bound
    registry snapshot, holding both profile carry locks. The live caller
    must stop the source writer, exclude other live writers and hold the
    PTY and operation fence through confirmed relaunch. *)
