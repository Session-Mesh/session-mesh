// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import fs from 'node:fs';
import path from 'node:path';

/** Make a fake agent visible to a fresh login shell in this test's private HOME. */
export function appendFixturePath(home: string, searchPath: string): void {
  const quoted = `'${searchPath.replaceAll("'", "'\\''")}'`;
  fs.appendFileSync(path.join(home, '.profile'), `\nexport PATH=${quoted}\n`, {mode: 0o600});
}
