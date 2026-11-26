// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// All signals and instrumentation are confined to this fixture's private child and native host.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {test, type TestContext} from 'node:test';
import {waitFor} from './ptyhost-wire-lib.ts';

function owner(t: TestContext, inspectReady = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsig-'));
  const observation = path.join(directory, 'listeners.json');
  const preload = path.join(directory, 'inspect-ready.cjs');
  if (inspectReady) fs.writeFileSync(preload, `
const fs = require('node:fs');
const write = process.stdout.write;
process.stdout.write = function(chunk) {
  if (String(chunk).startsWith('{"home":')) {
    fs.writeFileSync(${JSON.stringify(observation)}, JSON.stringify({
      SIGTERM: process.listenerCount('SIGTERM'), SIGINT: process.listenerCount('SIGINT')
    }));
  }
  return write.apply(this, arguments);
};
`);
  const native = process.env.MESH_PTYHOST_CMD;
  if (native) assert.ok(path.isAbsolute(native) && fs.existsSync(native), 'MESH_PTYHOST_CMD must name the native executable');
  const child = spawn(process.execPath, [
    ...(inspectReady ? ['--require', preload] : []),
    '--experimental-strip-types', path.resolve(import.meta.dirname, '../checks/dictation-ptyhost.ts'),
  ], {env: {PATH: process.env.PATH, HOME: directory, TMPDIR: directory,
    ...(native ? {MESH_PTYHOST_CMD: native} : {})}, stdio: ['pipe', 'pipe', 'pipe']});
  let output = '', errors = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => errors += data);
  child.on('error', error => errors += error.message);
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  t.after(async () => {
    child.stdin.end();
    if (!exited()) {
      try { await waitFor('private owner cleanup', 6000, exited); }
      catch { child.kill('SIGKILL'); }
    }
    await closed;
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {child, observation, async ready() {
    await waitFor('private native fixture ready', 7000, () => {
      assert.equal(exited(), false, errors);
      return output.includes('\n');
    });
    return JSON.parse(output.trim()) as {home: string; socket: string};
  }, async stopped() {
    await waitFor('private fixture shutdown with stdin still open', 2500, exited);
    await closed;
    assert.equal(child.exitCode, 0, errors);
    assert.equal(child.signalCode, null, errors);
  }};
}

test('native fixture installs both signal handlers before writing readiness', {timeout: 15000}, async t => {
  const fixture = owner(t, true);
  const {home} = await fixture.ready();
  const listeners = JSON.parse(fs.readFileSync(fixture.observation, 'utf8'));
  fixture.child.stdin.end();
  await fixture.stopped();
  assert.equal(fs.existsSync(home), false, 'the private native runtime was removed');
  for (const signal of ['SIGTERM', 'SIGINT']) assert.ok(listeners[signal] > 0, `${signal} must be installed at the readiness write`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  test(`native fixture exits zero on ${signal} with stdin still open`, {timeout: 15000}, async t => {
    const fixture = owner(t);
    const {home} = await fixture.ready();
    assert.equal(fixture.child.stdin.writableEnded, false);
    assert.equal(fixture.child.kill(signal), true);
    await fixture.stopped();
    assert.equal(fs.existsSync(home), false, 'the private native runtime was removed');
  });
}
