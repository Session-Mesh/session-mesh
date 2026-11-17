// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The gitleaks adapter: a secret in a commit message can never be excepted, the raw gitleaks
// report never lands on disk (even when the scan is interrupted), and neither a malformed report
// nor gitleaks' own error output can bring a scanned value into what the tool prints.
// A fake gitleaks (a shell script) stands in for the real one where its behaviour is forced.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {applyExceptions, loadExceptions} from '../tools/leak-guard/exceptions.ts';
import {scanSecrets} from '../tools/leak-guard/gitleaks.ts';
import {CLI, FAKE, TRAILER, baseEnv, remove, runCli, tempDir, write} from './leak-guard-fixtures.ts';

const scratch = tempDir('gitleaks-adapter');
const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const SECRET_MATCH = `github-pat:sha256:${digest(FAKE.token)}`;

// Writes the report where --report-path says ("-" is standard output), then behaves as FAKE_GL_MODE asks.
const FAKE_GITLEAKS = `#!/bin/sh
[ "$1" = version ] && exit 0
report=""
while [ $# -gt 0 ]; do [ "$1" = --report-path ] && report="$2"; shift; done
emit() { if [ "$report" = - ]; then printf '%s' "$1"; else printf '%s' "$1" > "$report"; fi; }
leak="[{\\"RuleID\\":\\"github-pat\\",\\"File\\":\\"a.env\\",\\"StartLine\\":1,\\"Secret\\":\\"$FAKE_GL_SECRET\\"}]"
case "$FAKE_GL_MODE" in
  slow) emit "$leak"; echo $$ > "$FAKE_GL_READY.tmp"; mv "$FAKE_GL_READY.tmp" "$FAKE_GL_READY"; exec sleep 30 ;;
  malformed) emit "not json $FAKE_GL_SECRET"; exit 0 ;;
  shape) emit "[{\\"RuleID\\":\\"$FAKE_GL_SECRET\\"}]"; exit 0 ;;
  stderr) echo "error near $FAKE_GL_SECRET" >&2; exit 1 ;;
esac
`;

function fakeGitleaks(): string {
  const file = path.join(scratch, 'fake-gitleaks');
  if (!fs.existsSync(file)) fs.writeFileSync(file, FAKE_GITLEAKS, {mode: 0o755});
  return file;
}

function fakeEnv(mode: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return baseEnv({MESH_LEAK_GITLEAKS: fakeGitleaks(), FAKE_GL_MODE: mode, FAKE_GL_SECRET: FAKE.token, ...extra});
}

function filesUnder(directory: string): string[] {
  return fs.readdirSync(directory, {withFileTypes: true, recursive: true})
    .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
}

async function waitFor(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('gitleaks adapter: messages are never excepted', () => {
  for (const exceptedPath of ['<message>', '0123456789:<message>', '<author>', '/etc/passwd', '../outside.env', 'a/./b']) {
    test(`an exception whose path is not a tree path is refused at load (${exceptedPath})`, () => {
      const file = path.join(scratch, 'not-tree.json');
      fs.writeFileSync(file, JSON.stringify({schema: 1, exceptions: [{path: exceptedPath, rule: 'secret', substring: SECRET_MATCH, reason: 'x'}]}));
      assert.throws(() => loadExceptions(file), /tree path/);
    });
  }

  const haveGitleaks = !runCli(scratch, ['message', '/dev/null']).output.includes('gitleaks not found');
  test('a secret in a message stays refused despite an exception naming the message', {skip: !haveGitleaks && 'gitleaks is not installed: secret scanning tests skipped'}, () => {
    const dir = tempDir('message-secret');
    write(dir, 'msg.txt', `subject\n\ntoken ${FAKE.token}\n\n${TRAILER}\n`);
    write(dir, 'exceptions.json', JSON.stringify({schema: 1,
      exceptions: [{path: '<message>', rule: 'secret', substring: SECRET_MATCH, reason: 'x'}]}));
    const run = runCli(dir, ['--exceptions', 'exceptions.json', 'message', 'msg.txt'], baseEnv());
    assert.notEqual(run.status, 0, run.output);
    assert.ok(!run.output.includes(FAKE.token));
    remove(dir);
  });

  test('a secret found in a message carries no value an exception could match', {skip: !haveGitleaks && 'gitleaks is not installed: secret scanning tests skipped'}, () => {
    const scan = scanSecrets({kind: 'texts', texts: [{label: '<message>', text: `token ${FAKE.token}`}]});
    assert.equal(scan.findings.length, 1);
    assert.equal(scan.findings[0].match, undefined);
    assert.equal(scan.findings[0].treePath, undefined);
  });
});

describe('gitleaks adapter: the raw report never stays on disk', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    test(`an interrupted scan (${signal}) leaves no raw value under the temporary directory`, async () => {
      const temp = tempDir(`signal-${signal}`);
      const tree = tempDir(`signal-tree-${signal}`);
      const ready = path.join(scratch, `ready-${signal}`);
      const env = fakeEnv('slow', {TMPDIR: temp, FAKE_GL_READY: ready});
      const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, 'tree', tree], {env, stdio: 'ignore'});
      const exited = new Promise(resolve => child.on('exit', resolve));
      await waitFor(ready, 15000);
      const fakePid = Number(fs.readFileSync(ready, 'utf8'));
      child.kill(signal);
      await exited;
      try { process.kill(fakePid, 'SIGKILL'); } catch { /* already gone */ }
      const leaked = filesUnder(temp).filter(file => fs.readFileSync(file, 'utf8').includes(FAKE.token));
      assert.deepEqual(leaked, []);
      remove(temp);
      remove(tree);
    });
  }
});

describe('gitleaks adapter: failures print no scanned value', () => {
  for (const mode of ['malformed', 'shape']) {
    test(`a ${mode} report is an explicit error with no excerpt`, () => {
      const dir = tempDir(`report-${mode}`);
      const run = runCli(dir, ['tree', '.'], fakeEnv(mode));
      assert.equal(run.status, 2, run.output);
      assert.match(run.stderr, /gitleaks report/);
      assert.ok(!run.output.includes(FAKE.token), run.output);
      remove(dir);
    });
  }

  test('a failing gitleaks is reported without relaying its error output', () => {
    const dir = tempDir('report-stderr');
    const run = runCli(dir, ['tree', '.'], fakeEnv('stderr'));
    assert.equal(run.status, 2, run.output);
    assert.match(run.stderr, /gitleaks failed/);
    assert.ok(!run.output.includes(FAKE.token), run.output);
    remove(dir);
  });
});

describe('gitleaks adapter: a stale secret exception prints no digest', () => {
  test('stale-exception names the rule and the reason only', () => {
    const exception = {path: 'conf.env', rule: 'secret', substring: SECRET_MATCH, reason: 'test: a public value'};
    const [stale] = applyExceptions([], [exception], true);
    assert.equal(stale.rule, 'stale-exception');
    assert.ok(!stale.excerpt.includes(digest(FAKE.token)), stale.excerpt);
    assert.match(stale.excerpt, /test: a public value/);
  });
});
