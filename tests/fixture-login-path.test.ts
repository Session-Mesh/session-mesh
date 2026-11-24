// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {appendFixturePath} from './fixture-login-path.ts';

test('private login profile appends the literal fake PATH without replacing existing exports', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-login-'));
  try {
    const bin = path.join(home, "bin'$(printf injected)");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'mesh-fixture-agent'), '#!/bin/sh\nexit 0\n', {mode: 0o700});
    fs.writeFileSync(path.join(home, '.profile'), "export TEST_CREDENTIAL=kept\n");
    appendFixturePath(home, `${bin}:/usr/bin:/bin`);
    const result = spawnSync('/bin/sh', ['-lc', 'command -v mesh-fixture-agent; printf "credential=%s\\n" "$TEST_CREDENTIAL"'],
      {env: {HOME: home, PATH: '/usr/bin:/bin'}, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${path.join(bin, 'mesh-fixture-agent')}\ncredential=kept\n`);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
