(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** An incremental fold over an append-only JSON-lines file.

    The caller supplies a fold (an initial state and a step applied to each
    JSON line); {!update} brings a previous result up to date by reading only
    the bytes appended since, and starts again from an empty state when the
    file was rewritten. It ports the Python reference of the History index
    ([history._parse], [_feed], [_rewritten]) and the tail window of
    [discover._tail_lines]:

    - only complete lines are folded; a last line without its newline is
      read again on the next call;
    - the first read of a file larger than [window] starts [window] bytes
      before its end and drops the bytes up to and including the first
      newline there, as Python's [seek] then [readline()] does;
    - the file counts as rewritten, and is folded again from an empty state,
      when its device or inode changed, when it is shorter than the cursor,
      or when the (at most 256) bytes that end at the cursor changed. Python
      checks those bytes for one agent only; this module always does;
    - a line longer than [max_line_bytes] is dropped without being held in
      memory, a line nested deeper than [max_depth] is dropped before it is
      parsed, and a line that is not strict JSON is dropped. They are counted
      in {!stats};
    - the input policy is {!Mesh_jsonl_value}'s: comments and raw control
      characters in strings are refused; a line that is not UTF-8 is dropped
      ([invalid_utf8 = Reject], as [history._feed]) or stripped of its
      invalid bytes ([Drop], as [discover._tail_lines]);
    - a duplicated object key keeps its last value ({!Mesh_jsonl_value});
    - a call reads at most [max_read] bytes (but at least [max_line_bytes + 1]
      when the file has them, so that every call makes progress), so that
      its duration is bounded; {!complete} says whether a later call has more
      to read.

    The file is opened with {!Mesh_safe_file.open_regular}: a symbolic link,
    FIFO or device is refused without blocking. Reads are ordinary blocking
    reads of a regular file: a caller with a deadline runs {!update} in a
    system thread ([Mesh_deadline_pool.Blocking]).

    {!update} returns a new result and never changes the previous one, which
    stays valid (its state, cursor and signature agree) provided the fold's
    [copy] is right: the steps of an [Appended] read run on [copy] of the
    previous state, as Python [deepcopy]s the entry. A cache of results is a
    [Mesh_lru] keyed by path; the {!Signature} of a result tells whether the
    file changed. When an [lstat] of the path matches the signature of a
    complete previous result, the file is not opened ([Unchanged]). *)

type 's fold = { init : unit -> 's; copy : 's -> 's; step : 's -> Yojson.Safe.t -> 's }
(** [copy] gives a state that later steps may change without changing its
    argument: [Fun.id] for a persistent (immutable) state, a deep copy for a
    mutable one ([Hashtbl.copy] when the values are immutable).

    [step] may raise [Yojson.Safe.Util.Type_error], [Not_found], [Failure] or
    [Invalid_argument] on a line of a shape it does not expect: the line is
    then dropped and the state before it kept, as Python's readers do with
    their [_BAD_LINE] exceptions. Other exceptions propagate. A mutable state
    changed by a step that then raises keeps that change (in the copy). *)

type limits = {
  max_line_bytes : int;
  max_depth : int;
  window : int;  (** The bytes the first read of a file covers at most. *)
  max_read : int;  (** The bytes one {!update} reads at most. *)
  invalid_utf8 : Mesh_jsonl_value.invalid_utf8;
}

val limits :
  ?max_line_bytes:int ->
  ?max_depth:int ->
  ?window:int ->
  ?max_read:int ->
  ?invalid_utf8:Mesh_jsonl_value.invalid_utf8 ->
  unit ->
  limits
(** Defaults: 1 MiB lines, depth 128, a window of 8 MiB (the Codex window of
    the Python reader; Claude's is 1.5 MB), 64 MiB per call, and [Reject].
    @raise Invalid_argument if a value is below 1. *)

module Signature : sig
  type t = { path : string; device : int; inode : int; size : int; mtime : float }
  (** What changes when the file does, as [fstat] saw it. *)

  val equal : t -> t -> bool
  val hash : t -> int
end

type 's t

type stats = {
  lines : int;  (** Lines folded since the last start from an empty state. *)
  dropped : int;  (** Lines dropped (too long, too deep, not JSON, bad shape). *)
  resets : int;  (** Starts from an empty state after a rewrite, over the life of the result. *)
}

type outcome =
  | Unchanged  (** Same file, same size and time, nothing left to read. *)
  | Appended  (** Bytes read after the previous cursor. *)
  | Restarted  (** First read, or a rewrite: folded from an empty state. *)

val update :
  limits -> 's fold -> string -> 's t option -> ('s t * outcome, Mesh_safe_file.error) result
(** [update limits fold path previous]. [previous] must come from the same
    [fold] and [path]; a result of another path counts as a rewrite. *)

val state : 's t -> 's
val signature : 's t -> Signature.t

val offset : 's t -> int
(** Where the next read starts. *)

val complete : 's t -> bool
(** Every byte up to the size seen at the last call was examined. *)

val stats : 's t -> stats
