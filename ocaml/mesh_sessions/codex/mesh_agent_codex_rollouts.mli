(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Codex's recent rollouts and what their first line says, as
    [discover.recent_rollouts] and [discover._rollout_meta] read them.

    {b One walk per round.} {!walk} lists
    [~/.codex/sessions/*/*/*/rollout-*.jsonl] in the day directories modified
    in the last 30 days (names that start with a dot skipped, as Python's
    glob does), with each file's [lstat]. Only regular files are kept: a
    symbolic link, FIFO or device is never opened (Python follows links).

    {b Headers cached by file.} The first line of a rollout is immutable once
    written. Its decoded header is cached by path with the file's device,
    inode, size and modification time in integer nanoseconds
    ({!Mesh_agent_codex_stat.lstat_regular}): an entry stands while the file is the
    same one and either has not changed or still holds the complete first
    line it was read from. That second rule also keeps a header across an
    in-place rewrite of the first line that keeps the inode (Codex appends;
    it does not rewrite). A first line that is not complete yet is read again
    once the file changes. Entries not seen in the last two walks are
    dropped. Files are read outside the cache's lock.

    {b Saved and restored.} The cache holds plain data ({!entry}) so that it
    can be saved ({!entries}) and restored ({!restore}). A restored entry is
    untrusted: one that is not well formed is ignored (an absolute path, no
    negative number, a [line_end] within the file and the first 8 MB, an id
    that is [null] or a lowercase UUID, a [cwd] that is [null] or a string),
    and a well-formed one is used only once the file's key matches it
    exactly; from then on it follows the rules above. {!entries} gives only
    well-formed entries. *)

type header = {
  cwd : Yojson.Safe.t;  (** [payload.cwd], any JSON value. *)
  subagent : bool;  (** [payload.source] is an object: a sub-agent's rollout. *)
  id : Yojson.Safe.t;  (** [payload.id] when it is a string, else [`Null]. *)
}

val unknown : header
(** An unreadable rollout, or one whose first line is not a JSON object:
    [{cwd = null; subagent = true; id = null}], as Python's [(None, True, None)]. *)

type rollout = {
  path : string;
  mtime : float;  (** Seconds, as Python's [os.path.getmtime]. *)
  header : header;
}

type entry = {
  device : int;
  inode : int;
  size : int;
  mtime_ns : int;  (** Modification time in nanoseconds. *)
  line_end : int option;  (** The byte after the first line's newline, when complete. *)
  header : header;
}

type t

val create : unit -> t

val walk : t -> root:string -> now:float -> rollout list
(** [root] is [~/.codex]. Sorted by path. *)

val describe_path : t -> string -> rollout option
(** A rollout found elsewhere (a path a process holds open), through the same
    cache; [None] when it is not a regular file. *)

type counters = { walks : int; headers_read : int  (** First lines read from disk. *) }

val counters : t -> counters
val entries : t -> (string * entry) list
val restore : t -> (string * entry) list -> unit
