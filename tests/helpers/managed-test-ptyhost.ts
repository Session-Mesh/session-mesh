// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import {spawn, type ChildProcess, type SpawnOptions} from 'node:child_process';
import {request, waitFor} from '../ptyhost-wire-lib.ts';

export function startTestPtyhost(argv: string[], options: SpawnOptions, socket: string) {
  const child: ChildProcess = spawn(argv[0]!, argv.slice(1), options);
  // Observe both events immediately, even if spawn fails before socket polling.
  let failure: Error | undefined;
  let ended = false;
  child.on('error', error => { failure = error; });
  const closed = new Promise<void>(resolve => child.once('close', () => { ended = true; resolve(); }));
  const ready = Promise.race([
    waitFor('private PTY host', 10000, () => ended || request(socket, {op:'list'}).then(() => true, () => false)),
    closed.then(() => { throw failure ?? new Error('test PTY host exited before readiness'); }),
  ]);
  return {child, ready, async stop() {
    if (child.exitCode === null && child.signalCode === null && !failure) child.kill('SIGKILL');
    await closed;
  }};
}
