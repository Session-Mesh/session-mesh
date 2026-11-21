// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A fake `codex` for the suites that restart or switch a Codex session through the server and a real PTY host: a
// shell script that logs its start and writes a rollout, then becomes a `sleep` named codex holding that rollout
// open, so the listing knows its conversation. Nothing here writes outside the directories the caller gives.
import fs from 'node:fs';
import path from 'node:path';

// codex|CODEX_HOME|session|arguments|session token|overlap. The rollout is held open (fd 3) by a process named codex,
// except in a session named x-guess*: that one writes its folder in the rollout and closes it, so the listing can
// only guess its conversation from the folder (cwd_unique). overlap is "yes" when the previous codex of the same
// session was still running at this start (its pid, kept through exec, is in a file). Started in a folder holding a
// file .stubborn, it ignores SIGHUP (only SIGKILL ends it), as an agent that does not exit on a hang-up would.
export const fakeCodex = (logFile: string, real: string) => [
  '#!/bin/sh',
  'if [ -e ./.stubborn ]; then trap "" HUP; fi',
  `pids='${logFile}.'"$MESH_SESSION"; overlap=no`,
  'if [ -f "$pids" ] && kill -0 "$(cat "$pids")" 2>/dev/null; then overlap=yes; fi; echo $$ > "$pids"',
  `printf '%s|%s|%s|%s|%s|%s\\n' codex "\${CODEX_HOME-unset}" "$MESH_SESSION" "$*" "$MESH_SESSION_TOKEN" "$overlap" >> '${logFile}'`,
  'if [ "$1" = resume ]; then id=$2; else id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr A-F a-f); fi',
  'folder="${CODEX_HOME:-$HOME/.codex}/sessions/2026/11/20"; mkdir -p "$folder"',
  'rollout="$folder/rollout-2026-11-20T10-00-00-$id.jsonl"',
  'case "$MESH_SESSION" in x-guess*)',
  `  printf '{"type":"session_meta","payload":{"id":"%s","cwd":"%s"}}\\n' "$id" "$(pwd -P)" >> "$rollout"; exec '${real}/codex' 300;;`,
  'esac',
  `printf '{"type":"session_meta","payload":{"id":"%s","home":"%s"}}\\n' "$id" "\${CODEX_HOME-default}" >> "$rollout"`,
  `exec 3<"$rollout"; exec '${real}/codex' 300`, ''].join('\n');

/** Install the fake in ``bin`` (its log is ``bin/launches.log``): the PATH to give the server and the PTY host. */
export function installFakeCodex(bin: string): {log: string; PATH: string} {
  const log = path.join(bin, 'launches.log');
  const real = path.join(bin, 'real');   // a `sleep` named codex: the process the listing recognises
  fs.mkdirSync(real);
  fs.copyFileSync(fs.realpathSync('/bin/sleep'), path.join(real, 'codex'));
  fs.chmodSync(path.join(real, 'codex'), 0o755);
  fs.writeFileSync(path.join(bin, 'codex'), fakeCodex(log, real), {mode: 0o755});
  return {log, PATH: `${bin}:${process.env.PATH}`};
}

/** Every launch the fake logged, as its fields. */
export const launchesIn = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').split('\n')
  .filter(Boolean).map(line => line.split('|'));

export const rolloutIn = (home: string, sid: string) =>
  path.join(home, 'sessions', '2026', '11', '20', `rollout-2026-11-20T10-00-00-${sid}.jsonl`);
