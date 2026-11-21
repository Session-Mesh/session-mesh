// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {removeScratch} from './mesh-server-lib.ts';

const helper = new URL('./helpers/copilot-availability.ts', import.meta.url).href;
for (const mode of ['success', 'failure', 'timeout', 'spawn-error', 'unavailable']) test(`Copilot version probe isolates user context and cleans ${mode}`, {timeout: 10000}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'));
  try {
    const bin = path.join(root, 'bin'), outside = path.join(root, 'outside'), temp = path.join(root, 'tmp');
    for (const directory of [bin, outside, temp]) fs.mkdirSync(directory, {mode: 0o700});
    const record = path.join(root, 'record.json'), outsideRecord = path.join(root, 'outside-invoked');
    const cli = `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({env:process.env,cwd:process.cwd(),args:process.argv.slice(2)}));\n${mode === 'timeout' ? 'setInterval(()=>{},1000);' : `process.exit(${mode === 'failure' ? 1 : 0});`}`;
    if (mode !== 'unavailable') fs.writeFileSync(path.join(bin, 'copilot'), mode === 'spawn-error' ? '#!/definitely-missing-probe-interpreter\n' : cli, {mode: 0o700});
    fs.writeFileSync(path.join(outside, 'copilot'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(outsideRecord)},'unexpected');`, {mode: 0o700});
    const outerHome = path.join(root, 'outer-home'); fs.mkdirSync(outerHome, {mode: 0o700});
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `import {usableCopilot} from ${JSON.stringify(helper)};console.log(JSON.stringify({value:usableCopilot(process.env.PATH,500)}));`],
    {cwd: root, encoding: 'utf8', timeout: 5000, env: {PATH: bin, HOME: outerHome, XDG_CONFIG_HOME: outside,
      XDG_DATA_HOME: outside, XDG_CACHE_HOME: outside, COPILOT_HOME: outside, TMPDIR: temp,
      COPILOT_GITHUB_TOKEN: 'synthetic-secret', GITHUB_TOKEN: 'synthetic-secret', ANTHROPIC_API_KEY: 'synthetic-secret',
      SSH_AUTH_SOCK: path.join(outside, 'agent.sock')}});
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).value, mode === 'success' ? path.join(bin, 'copilot') : '');
    assert.deepEqual(fs.readdirSync(temp), [], 'all probe scratch directories removed');
    assert.equal(fs.existsSync(outsideRecord), false, 'no program outside validation PATH called');
    if (mode === 'success' || mode === 'failure') {
      const value = JSON.parse(fs.readFileSync(record, 'utf8'));
      assert.deepEqual(value.args, ['--version']);
      assert.deepEqual(Object.keys(value.env).sort(), ['COPILOT_HOME', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'].sort());
      for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'COPILOT_HOME', 'TMPDIR']) {
        assert.ok(value.env[key].startsWith(temp + path.sep));
        assert.notEqual(value.env[key], outerHome); assert.notEqual(value.env[key], outside);
        assert.equal(fs.existsSync(value.env[key]), false, 'probe-owned directory cleaned');
      }
      assert.ok(value.cwd.startsWith(temp + path.sep));
      assert.equal(Object.values(value.env).includes('synthetic-secret'), false);
    }
  } finally {removeScratch(root);}
});
