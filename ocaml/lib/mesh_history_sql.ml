(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Every statement of the history store, as a typed Caqti request: parameters
   are bound, data never enters a query string. The only SQL built from
   OCaml strings is the static DDL of the migrations (no data involved). *)

open Caqti_type.Std
open Caqti_request.Infix

type conv_row = {
  agent : string;
  id : string;
  path : string;
  cwd : string;
  title : string;
  started : float option;
  updated : float option;
  tokens : int option;
  summary_len : int;
  meta : string;
  gen : int;
}

let conv_row =
  product (fun agent id path cwd title started updated tokens summary_len meta gen ->
      { agent; id; path; cwd; title; started; updated; tokens; summary_len; meta; gen })
  @@ proj string (fun r -> r.agent)
  @@ proj string (fun r -> r.id)
  @@ proj string (fun r -> r.path)
  @@ proj string (fun r -> r.cwd)
  @@ proj string (fun r -> r.title)
  @@ proj (option float) (fun r -> r.started)
  @@ proj (option float) (fun r -> r.updated)
  @@ proj (option int) (fun r -> r.tokens)
  @@ proj int (fun r -> r.summary_len)
  @@ proj string (fun r -> r.meta)
  @@ proj int (fun r -> r.gen)
  @@ proj_end

let ddl sql =
  Caqti_request.create ~oneshot:true unit unit Caqti_mult.zero (fun _ ->
      Caqti_query.L sql)

(* ---- pragmas (they answer with a row, hence the row types) ---- *)

let set_busy_timeout ms =
  Caqti_request.create ~oneshot:true unit int Caqti_mult.zero_or_more (fun _ ->
      Caqti_query.L (Printf.sprintf "PRAGMA busy_timeout = %d" ms))

let set_wal =
  Caqti_request.create unit string Caqti_mult.zero_or_more (fun _ ->
      Caqti_query.L "PRAGMA journal_mode = WAL")

let set_synchronous_normal = ddl "PRAGMA synchronous = NORMAL"

(* ---- migrations ---- *)

let migrations_table =
  ddl
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, \
     applied_at INTEGER NOT NULL)"

let applied_versions = (unit ->* int) "SELECT version FROM schema_migrations ORDER BY version"
let record_migration = (t2 int int ->. unit) "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)"

let create_state =
  ddl
    "CREATE TABLE state (id INTEGER PRIMARY KEY CHECK (id = 1), gen INTEGER NOT NULL, \
     floor INTEGER NOT NULL, tokenizer TEXT NOT NULL)"

let init_state = (t3 int int string ->. unit) "INSERT INTO state (id, gen, floor, tokenizer) VALUES (1, ?, ?, ?)"

let create_conversations =
  ddl
    "CREATE TABLE conversations (cid INTEGER PRIMARY KEY, agent TEXT NOT NULL, id TEXT NOT NULL, \
     path TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, started REAL, updated REAL, \
     tokens INTEGER, summary TEXT NOT NULL, meta TEXT NOT NULL, gen INTEGER NOT NULL, \
     cursor_offset INTEGER NOT NULL DEFAULT 0, next_seq INTEGER NOT NULL DEFAULT 0, \
     UNIQUE (agent, id))"

let conversation_indexes =
  [ ddl "CREATE INDEX conversations_gen ON conversations (gen)";
    ddl "CREATE INDEX conversations_updated ON conversations (updated DESC)";
    ddl "CREATE INDEX conversations_path ON conversations (path)" ]

let create_tombstones =
  ddl
    "CREATE TABLE tombstones (tid INTEGER PRIMARY KEY, gen INTEGER NOT NULL, agent TEXT NOT NULL, \
     id TEXT NOT NULL)"

let tombstone_indexes =
  [ ddl "CREATE INDEX tombstones_gen ON tombstones (gen)";
    ddl "CREATE INDEX tombstones_key ON tombstones (agent, id)" ]

let create_chunks =
  ddl
    "CREATE TABLE chunks (cid INTEGER PRIMARY KEY, conv INTEGER NOT NULL, seq INTEGER NOT NULL, \
     role TEXT NOT NULL, text TEXT NOT NULL, UNIQUE (conv, seq))"

let create_fts tokenizer =
  ddl
    (Printf.sprintf
       "CREATE VIRTUAL TABLE chunk_fts USING fts5 (text, content = 'chunks', \
        content_rowid = 'cid', tokenize = '%s')"
       tokenizer)

let fts_triggers =
  [ ddl
      "CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunk_fts (rowid, text) \
       VALUES (new.cid, new.text); END";
    ddl
      "CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunk_fts (chunk_fts, \
       rowid, text) VALUES ('delete', old.cid, old.text); END";
    ddl
      "CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN INSERT INTO chunk_fts (chunk_fts, \
       rowid, text) VALUES ('delete', old.cid, old.text); INSERT INTO chunk_fts (rowid, text) \
       VALUES (new.cid, new.text); END" ]

(* ---- state ---- *)

let read_state = (unit ->! t2 int int) "SELECT gen, floor FROM state WHERE id = 1"
let raise_gen = (int ->. unit) "UPDATE state SET gen = MAX(gen, ?) WHERE id = 1"
let tokenizer = (unit ->! string) "SELECT tokenizer FROM state WHERE id = 1"

(* ---- conversations ---- *)

let upsert_conversation =
  (t11 string string string string string (option float) (option float) (option int) string string
     int
   ->. unit)
    "INSERT INTO conversations (agent, id, path, cwd, title, started, updated, tokens, summary, \
     meta, gen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (agent, id) DO UPDATE SET \
     path = excluded.path, cwd = excluded.cwd, title = excluded.title, started = excluded.started, \
     updated = excluded.updated, tokens = excluded.tokens, summary = excluded.summary, \
     meta = excluded.meta, gen = excluded.gen"

let find_cid = (t2 string string ->? int) "SELECT cid FROM conversations WHERE agent = ? AND id = ?"

let add_epoch =
  ddl "ALTER TABLE conversations ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0"

let set_cursor =
  (t4 int int int int ->. unit)
    "UPDATE conversations SET cursor_offset = ?, next_seq = ?, epoch = ? WHERE cid = ?"

let drop_all_chunks = (int ->. unit) "DELETE FROM chunks WHERE conv = ?"
let drop_text_chunks = (int ->. unit) "DELETE FROM chunks WHERE conv = ? AND seq >= 0"
let drop_title_chunk = (int ->. unit) "DELETE FROM chunks WHERE conv = ? AND seq = -1"

let drop_chunk = (t2 int int ->. unit) "DELETE FROM chunks WHERE conv = ? AND seq = ?"

let upsert_chunk =
  (t4 int int string string ->. unit)
    "INSERT INTO chunks (conv, seq, role, text) VALUES (?, ?, ?, ?) ON CONFLICT (conv, seq) DO \
     UPDATE SET role = excluded.role, text = excluded.text"

let drop_conversation = (int ->. unit) "DELETE FROM conversations WHERE cid = ?"
let drop_tombstones = (t2 string string ->. unit) "DELETE FROM tombstones WHERE agent = ? AND id = ?"
let add_tombstone = (t3 int string string ->. unit) "INSERT INTO tombstones (gen, agent, id) VALUES (?, ?, ?)"

let prune_floor =
  (int ->. unit)
    "UPDATE state SET floor = MAX(floor, COALESCE((SELECT MAX(gen) FROM tombstones WHERE tid <= \
     (SELECT MAX(tid) FROM tombstones) - ?), 0)) WHERE id = 1"

let prune_tombstones =
  (int ->. unit) "DELETE FROM tombstones WHERE tid <= (SELECT MAX(tid) FROM tombstones) - ?"

let conv_columns =
  "agent, id, path, cwd, title, started, updated, tokens, LENGTH(summary), meta, gen"

let list_all =
  (unit ->* conv_row)
    ("SELECT " ^ conv_columns ^ " FROM conversations ORDER BY updated DESC, cid DESC")

let list_since =
  (int ->* conv_row)
    ("SELECT " ^ conv_columns
   ^ " FROM conversations WHERE gen > ? ORDER BY updated DESC, cid DESC")

let gone_since =
  (int ->* t2 string string) "SELECT agent, id FROM tombstones WHERE gen > ? ORDER BY tid"

let one_conversation =
  (t2 string string ->? conv_row)
    ("SELECT " ^ conv_columns ^ " FROM conversations WHERE agent = ? AND id = ?")

let summary_of = (t2 string string ->? string) "SELECT summary FROM conversations WHERE agent = ? AND id = ?"

let all_cursors =
  (unit ->* t7 string string string int int int int)
    "SELECT agent, id, path, cursor_offset, next_seq, gen, epoch FROM conversations"

(* ---- search and statistics ---- *)

let search =
  (t2 string int ->* t4 string string float string)
    "SELECT c.agent, c.id, bm25(chunk_fts), snippet(chunk_fts, 0, '', '', '...', 16) FROM \
     chunk_fts JOIN chunks ON chunks.cid = chunk_fts.rowid JOIN conversations c ON c.cid = \
     chunks.conv WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT ?"

let sqlite_version = (unit ->! string) "SELECT sqlite_version()"
let count_conversations = (unit ->! int) "SELECT COUNT(*) FROM conversations"
let count_chunks = (unit ->! int) "SELECT COUNT(*) FROM chunks"
