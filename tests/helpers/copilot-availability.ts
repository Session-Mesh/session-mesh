// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {removeScratch} from '../mesh-server-lib.ts';

/** Probe the first executable in the absolute validation PATH, with no user context. */
export function usableCopilot(pathValue: string, timeoutMs = 10000): string {
  let executable = '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, 'copilot');
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK); executable = candidate; break;
    } catch { /* Not an executable PATH entry. */ }
  }
  if (!executable) return '';
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-version-'));
  try {
    const directories = Object.fromEntries(['home', 'config', 'data', 'cache', 'copilot', 'tmp'].map(name => [name, path.join(scratch, name)]));
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, {mode: 0o700});
    execFileSync(executable, ['--version'], {cwd: scratch, stdio: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL',
      env: {PATH: pathValue, HOME: directories.home, XDG_CONFIG_HOME: directories.config,
        XDG_DATA_HOME: directories.data, XDG_CACHE_HOME: directories.cache, COPILOT_HOME: directories.copilot,
        TMPDIR: directories.tmp, LANG: 'C', LC_ALL: 'C'}});
    return executable;
  } catch { return ''; }
  finally {removeScratch(scratch);}
}
