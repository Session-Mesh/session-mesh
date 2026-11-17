// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A stand-in for OpenCode's SQLite store and process, for the OpenCode tests: the columns Mesh reads, with
// OpenCode 1.18.35's real types, and a process the kernel names `opencode`.
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

// A `credential` table stands for the provider credentials the real file also holds: Mesh must never read it.
export function createStore(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, parent_id text, time_created integer NOT NULL,
             time_updated integer NOT NULL, time_archived integer);
           CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
             time_updated integer NOT NULL, data text NOT NULL);
           CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
             time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
           CREATE TABLE credential (id text PRIMARY KEY, value text NOT NULL);`);
  return db;
}

export function addConversation(db: DatabaseSync, id: string, directory: string,
  opts: {parent?: string; open: boolean; updated: number}): void {
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, NULL)').run(id, directory, opts.parent ?? null, opts.updated - 5000, opts.updated);
  const message = (suffix: string, at: number, data: object, text: string) => {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(`${id}-${suffix}`, id, at, at, JSON.stringify(data));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(`${id}-${suffix}-p`, `${id}-${suffix}`, id, at, at,
      JSON.stringify({type: 'text', text}));
  };
  message('1', opts.updated - 4000, {role: 'user', time: {created: opts.updated - 4000}}, `question of ${id}`);
  const completed = opts.open ? {} : {completed: opts.updated};
  message('2', opts.updated - 1000, {role: 'assistant', time: {created: opts.updated - 1000, ...completed}}, `answer of ${id}`);
}

/** OpenCode 2's store: the conversations are in `session_v2` (with `time_busy` / `time_idle`) and `session_message`;
 *  a database migrated from 1.x also keeps the old `session` table (`legacySession`). */
export function createStoreV2(file: string, opts: {legacySession?: boolean} = {}): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, directory text NOT NULL, parent_id text, time_created integer NOT NULL,
             time_updated integer NOT NULL, time_busy integer, time_idle integer, time_archived integer);
           CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
             time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
           CREATE TABLE credential (id text PRIMARY KEY, value text NOT NULL);`);
  if (opts.legacySession) {
    db.exec(`CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, parent_id text, time_created integer NOT NULL,
               time_updated integer NOT NULL, time_archived integer);`);
  }
  return db;
}

export function addConversationV2(db: DatabaseSync, id: string, directory: string,
  opts: {parent?: string; updated: number; busy?: boolean; legacyOnly?: boolean}): void {
  if (opts.legacyOnly) {
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, NULL)').run(id, directory, opts.parent ?? null, opts.updated - 5000, opts.updated);
    return;
  }
  const busy = opts.busy ? opts.updated - 500 : opts.updated - 3000;
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(id, directory, opts.parent ?? null,
    opts.updated - 5000, opts.updated, busy, opts.busy ? null : opts.updated - 100);
  const message = (seq: number, type: string, at: number, data: object) =>
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(`${id}-${seq}`, id, type, seq, at, at, JSON.stringify(data));
  message(1, 'user', opts.updated - 4000, {time: {created: opts.updated - 4000}, text: `question of ${id}`, files: []});
  message(2, 'assistant', opts.updated - 1000, {time: {created: opts.updated - 1000},
    content: [{type: 'reasoning', text: 'thinking'}, {type: 'text', text: `answer of ${id}`}]});
}

/** A process named opencode (the executable `script`) in `directory`; resolves once the kernel names it so. */
export async function startFakeOpencode(script: string, directory: string, args: string[]): Promise<ChildProcess> {
  const child = spawn(script, args, {cwd: directory, stdio: 'ignore'});
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (fs.readFileSync(`/proc/${child.pid}/comm`, 'utf8').trim() === 'opencode') break;
    } catch { /* not started yet */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return child;
}
