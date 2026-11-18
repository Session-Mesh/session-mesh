// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import fs from 'node:fs';
import path from 'node:path';

/**
 * Links the system tools `names` into `dir`, the closed PATH of an installer fixture, each from
 * /usr/bin/<name> when it exists, else /bin/<name>: Linux keeps them all in /usr/bin (often with /bin
 * a link to it), while macOS keeps the base tools (mkdir, rm, ln, cat, chmod, sleep, bash, ...) in /bin
 * only. A tool that is in neither is left out, as on a system without it, and a name already in `dir`
 * (a fake of the fixture) is kept.
 */
export function linkSystemTools(names: readonly string[], dir: string): void {
  for (const name of names) {
    const link = path.join(dir, name);
    if (fs.existsSync(link)) continue;
    const file = ['/usr/bin', '/bin'].map(base => path.join(base, name)).find(candidate => fs.existsSync(candidate));
    if (file) fs.symlinkSync(file, link);
  }
}
