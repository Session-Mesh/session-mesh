// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Read-only documentation checks: never import the legacy native merge test or run OpenCode.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const read = (name: string) => fs.readFileSync(path.join(REPO, name), 'utf8');

test('security and launch documentation describe the current private config API probe', () => {
  const security = read('SECURITY.md').split('### The OpenCode preset\n')[1].split('\n### ')[0];
  const launch = read('server.py').split('async def new_session(')[1].split('"""')[1];
  for (const text of [security, launch]) {
    assert.match(text, /opencode api get/);
    assert.match(text, /\/api\/config/);
    assert.match(text, /location\[directory\]/);
    assert.match(text, /--standalone/);
    assert.doesNotMatch(text, /opencode debug config/);
  }
  assert.match(security, /no shared-service fallback/i);
});

test('native probe evidence is version-specific and the old merge test is labelled legacy', () => {
  const security = read('SECURITY.md').split('### The OpenCode preset\n')[1].split('\n### ')[0];
  const header = read('tests/opencode-config-merge.test.ts').split('import assert')[0];
  for (const text of [security, header]) {
    assert.match(text, /2\.0\.28-native1m\.1/);
    assert.match(text, /2\.3\.0 is not verified/);
  }
  assert.match(header, /Legacy native merge tests/);
  assert.match(header, /Do not run/);
  assert.match(header, /opencode-config-probe\.test\.ts/);
});
