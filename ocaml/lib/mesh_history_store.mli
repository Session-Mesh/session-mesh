(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The History index: conversations and their text chunks in one SQLite file,
    searched with FTS5. All access goes through typed Caqti requests.

    Every function returns [Error] instead of raising on database trouble
    (locked file, corruption, I/O); the caller decides what to do. *)

type error = {
  code : string;
      (** ["busy"], ["corrupt"], ["bad_request"] or ["db"]. *)
  message : string;
}

type t

val schema_version : int
(** The schema version this build writes; [open_] migrates up to it. *)

val open_ : ?busy_timeout_ms:int -> path:string -> unit -> (t, error) result
(** Open (creating it with mode 0600 if absent) and migrate the database at
    [path], in WAL mode. Waits up to [busy_timeout_ms] (default 5000) on a
    lock. A database newer than {!schema_version} is refused. *)

val close : t -> unit

val applied_versions : t -> (int list, error) result
(** The versions recorded in the migration table, ascending. *)

val tokenizer : t -> (string, error) result
(** The FTS5 tokenizer specification the index was created with. *)

val sqlite_version : t -> (string, error) result
(** The version of the SQLite library the executable carries ([sqlite_version()]). *)

type conversation = {
  agent : string;
  id : string;
  path : string;
  cwd : string;
  title : string;
  started : float option;
  updated : float option;
  tokens : int option;
  summary : string;
  meta : string;
      (** Opaque JSON object text, returned as is by [list] and [detail]. *)
}

type chunk = { seq : int; role : string; text : string }
(** [seq] is non-negative; the title is indexed separately. *)

type cursor = { offset : int; next_seq : int; epoch : int }
(** Where the producer stopped reading the transcript: kept with the chunks,
    in the same transaction, so a restart resumes exactly. [epoch] counts how
    often the producer read the source again from the start: a stored epoch
    that differs from the producer's says the stored chunks are of an older
    reading (0 for rows written before schema 2). *)

val ingest :
  t ->
  ?gen:int ->
  ?cursor:cursor ->
  ?replace_chunks:bool ->
  conversation ->
  chunk list ->
  (int, error) result
(** Upsert the conversation and its chunks (keyed by agent, id, seq) in one
    transaction; replaying the same call changes nothing but the generation.
    [replace_chunks] first removes the chunks the conversation holds. A chunk
    with an empty [text] removes the chunk of that [seq] instead. Returns
    the generation assigned: [gen] when given (the caller owns the sequence),
    otherwise the next one. Fails with ["bad_request"] on a negative [seq]. *)

val forget :
  t -> ?gen:int -> agent:string -> id:string -> unit -> (int option, error) result
(** Remove a conversation and its chunks and remember its removal for [list].
    [None] when it was not there. *)

type listed = {
  conversation : conversation;  (** [summary] is empty: see [has_summary]. *)
  has_summary : bool;
  gen : int;
}

type listing = {
  current : int;  (** The generation of the index. *)
  full : bool;  (** [sessions] is everything, [gone] is empty. *)
  sessions : listed list;  (** Newest [updated] first. *)
  gone : (string * string) list;  (** Removed [(agent, id)] since the generation. *)
}

val list : t -> ?current:int -> since:int option -> unit -> (listing, error) result
(** Entries changed after [since]. [current] is the generation the caller
    considers current when it owns the sequence (default: the index's own). [full]
    when [since] is [None], older than
    the oldest removal still remembered, or newer than the index. *)

val detail : t -> agent:string -> id:string -> ((listed * string) option, error) result
(** The conversation (the summary stays empty in [listed]) and its summary. *)

val cursors : t -> (((string * string * string) * cursor * int) list, error) result
(** For every conversation [(agent, id, path)], its stored cursor and generation. *)

type hit = { agent : string; id : string; score : float; snippet : string }

val search : t -> query:string -> limit:int -> (hit list, error) result
(** Conversations matching every term of [query] (see {!Mesh_history_query}),
    best first, one hit per conversation; [score] grows with relevance. The
    snippet is plain text. [limit] is clamped to 1..200. A query without
    searchable term yields no hit. *)

type stats = { conversations : int; chunks : int; generation : int }

val stats : t -> (stats, error) result
