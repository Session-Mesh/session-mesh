// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A real native PTY host (MESH_PTYHOST_CMD) that runs the update check against a stand-in `curl`, so
// no request leaves the machine. The host is copied to <share>/releases/v0.1.0/bin/, because a
// release install takes its version from the directory it runs from; `release: false` runs it from
// elsewhere, as a source install does.
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {nativePtyhost} from './native-ptyhost.ts';

export const NOTES = 'https://github.com/Session-Mesh/session-mesh/releases/tag/v0.2.0';
export const RELEASES = JSON.stringify([
  {tag_name: 'v0.2.0', draft: false, prerelease: false, body: 'Security: yes'},
  {tag_name: 'v0.1.0', draft: false, prerelease: false, body: ''},
]);

/** A curl that answers 200 with the releases above, whatever it is asked. */
export const ANSWERING_CURL = `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in -D) h=$2; shift ;; -o) o=$2; shift ;; esac
  shift
done
printf 'HTTP/2 200\\r\\netag: "t1"\\r\\n\\r\\n' > "$h"
printf '%s' '${RELEASES}' > "$o"
printf 200
`;

export type UpdateHost = {
  child: ChildProcess;
  log: () => string;
  socket: string;
  stop: () => Promise<void>;
};

export function startUpdateHost(mesh: {home: string}, options: {release: boolean; curl?: string}): UpdateHost {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'update-host-'));
  const fakebin = path.join(scratch, 'bin');
  fs.mkdirSync(fakebin);
  fs.writeFileSync(path.join(fakebin, 'curl'), options.curl ?? ANSWERING_CURL, {mode: 0o755});
  const directory = options.release ? path.join(scratch, 'share', 'releases', 'v0.1.0', 'bin') : path.join(scratch, 'source');
  fs.mkdirSync(directory, {recursive: true});
  const executable = path.join(directory, 'mesh-ptyhost');
  fs.copyFileSync(nativePtyhost()[0], executable);
  fs.chmodSync(executable, 0o755);
  let output = '';
  const child = spawn(executable, [], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {PATH: `${fakebin}:/usr/bin:/bin`, LANG: 'C', HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'),
      MESH_CACHE_DIR: path.join(mesh.home, '.cache', 'session-mesh')},
  });
  child.stderr?.on('data', chunk => { output += chunk; });
  return {
    child, log: () => output, socket: path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise(resolve => child.on('close', resolve));
        child.kill('SIGTERM');
        await closed;
      }
      fs.rmSync(scratch, {recursive: true, force: true});
    },
  };
}
