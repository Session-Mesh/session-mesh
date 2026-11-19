(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The Claude adapter: a Claude process described from
    [~/.claude/sessions/<pid>.json] (its conversation id, status and name) and
    from the conversation's transcript [~/.claude/projects/*/<id>.jsonl]
    (title, last prompt, how the last answer ends, a pending question), as
    [discover.claude_info] does. It only reads.

    {b Caches.} The transcript's fold ({!Mesh_agent_claude_fold}) is kept per
    conversation in a {!Mesh_lru} bounded to twice the listed sessions: an
    unchanged transcript (same file, size and modification time, by [lstat])
    is not opened again, and a grown one is read from where the last read
    stopped ({!Mesh_jsonl_tail}). Where each conversation's transcript is
    (or that it has none) is cached too, and searched again after a project
    directory changed: {!prepare} lists the project directories and [lstat]s
    each once per round, and a transcript created, removed or renamed in one
    changes its time. The first read of a transcript covers its last 1.5 MB, as
    Python does. The caches are guarded by a mutex: {!describe} runs in
    several system threads at once.

    Files are opened without following a link or blocking on a FIFO
    ({!Mesh_safe_file}); a conversation id that is not a plain file name is
    never used in a path. *)

include Mesh_agent.ADAPTER

type counters = {
  restarted : int;  (** Transcripts folded from their start (or window). *)
  appended : int;  (** Transcripts read from a previous cursor. *)
  unchanged : int;  (** Transcripts not opened: unchanged since the last read. *)
}

val counters : t -> counters
(** What the transcript cache did so far: tests check that a second round
    over unchanged transcripts decodes nothing. *)

val window : int
(** 1.5 MB: the bytes the first read of a transcript covers at most. *)
