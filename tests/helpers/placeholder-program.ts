// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A stand-in for work-read or work-write (MESH_WORK_READ_CMD / MESH_WORK_WRITE_CMD) for the tests of the relay's
// credential checks, which refuse before any program runs: they need no dune build, so they run wherever server.py
// does (the frontend and browser jobs of public CI included). The stand-in records that it ran, and the PATH it got,
// in a marker file, and answers one fixed JSON line with exit 0, so a request that should have been refused but
// reached it gets 200, never the expected refusal.
import fs from 'node:fs';
import path from 'node:path';

export type Placeholder = {
  /** The absolute path of the executable stand-in. */
  command: string;
  /** Whether it ran since it was made or last reset. */
  ran: () => boolean;
  /** The PATH it ran with ('' when it had none), or null when it has not run. */
  pathSeen: () => string | null;
  reset: () => void;
};

/** An executable stand-in named `name` in `directory` (a test's own temporary directory). */
export function placeholderProgram(directory: string, name: string): Placeholder {
  const command = path.join(directory, name);
  const marker = path.join(directory, `${name}.ran`);
  if (marker.includes("'")) throw new Error('the marker path must not hold a single quote');
  // Only shell built-ins: the relay gives its child a minimal environment.
  fs.writeFileSync(command, `#!/bin/sh\nprintf '%s' "\${PATH-}" > '${marker}'\nprintf '%s\\n' '{"schema":1,"placeholder":true}'\n`, { mode: 0o755 });
  const pathSeen = (): string | null => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
  return { command, ran: () => fs.existsSync(marker), pathSeen, reset: () => fs.rmSync(marker, { force: true }) };
}
