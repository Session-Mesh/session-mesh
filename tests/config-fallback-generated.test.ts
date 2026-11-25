// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';

test('configuration fallback is generated from the English catalog', () => {
  execFileSync(process.execPath, ['--experimental-strip-types', 'tools/generate-config-fallback.ts', '--check']);
});
