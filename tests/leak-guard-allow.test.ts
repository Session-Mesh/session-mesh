// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Authorizations (`allow`) kept in the private list: invented values and a temporary list only.
import assert from 'node:assert/strict';
import {after, describe, test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {FAKE, TRAILER, baseEnv, git, initRepo, remove, runCli, tempDir, write} from './leak-guard-fixtures.ts';

const scratch = tempDir('allow');
after(() => remove(scratch));

// Two invented URLs that both contain the private name, as two pinned sources would.
const FIRST = `https://forge.example/${FAKE.privateHost}/first.git`;
const SECOND = `https://forge.example/${FAKE.privateHost}/second.git`;

function privateList(name: string, allow: unknown): string {
  const file = path.join(scratch, `${name}.json`);
  const forbidden = [{id: 'host', literal: FAKE.privateHost, caseInsensitive: false}];
  fs.writeFileSync(file, JSON.stringify({schema: 1, forbidden, ...(allow === undefined ? {} : {allow})}));
  return file;
}

function tree(files: Record<string, string>): string {
  const dir = tempDir('allow-tree');
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  return dir;
}

const scanTree = (dir: string, list: string) => runCli(dir, ['--no-secrets', '--private', list, 'tree', '.'], baseEnv());

describe('private-list allow entries', () => {
  const both = [{path: 'boot.sh', rule: 'host', value: FIRST}, {path: 'boot.sh', rule: 'host', value: SECOND}];

  test('each entry lifts the occurrences inside its exact value, in its file only', () => {
    const dir = tree({'boot.sh': `pin ${FIRST}\npin ${SECOND}\n`, 'other.sh': `pin ${FIRST}\n`});
    const run = scanTree(dir, privateList('both', both));
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /other\.sh:1 {2}\[content\] private:host/);
    assert.doesNotMatch(run.stdout, /boot\.sh/);
    remove(dir);
  });

  test('an occurrence outside the value on the same line is still reported', () => {
    const dir = tree({'boot.sh': `pin ${FIRST} ${FAKE.privateHost}\npin ${SECOND}\n`});
    const run = scanTree(dir, privateList('outside', both));
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /boot\.sh:1 {2}\[content\] private:host/);
    assert.doesNotMatch(run.stdout, /boot\.sh:2/);
    remove(dir);
  });

  test('with both entries the file is clean', () => {
    const dir = tree({'boot.sh': `pin ${FIRST}\npin ${SECOND}\n`});
    assert.equal(scanTree(dir, privateList('clean', both)).status, 0);
    remove(dir);
  });

  test('an entry that matches nothing fails a full scan without printing its value', () => {
    const dir = tree({'boot.sh': `pin ${FIRST}\n`});
    const run = scanTree(dir, privateList('stale', both));
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /boot\.sh {2}\[content\] stale-private-allow/);
    assert.doesNotMatch(run.stdout, /second\.git/);
    remove(dir);
  });

  test('an entry never covers a commit message', () => {
    const file = path.join(scratch, 'message.txt');
    fs.writeFileSync(file, `fix ${FIRST}\n\n${TRAILER}\n`);
    const allow = [{path: '<message>', rule: 'host', value: FIRST}];
    assert.equal(runCli(scratch, ['--no-secrets', '--private', privateList('message', allow), 'message', file], baseEnv()).status, 1);
  });

  for (const [name, allow] of [
    ['unknown-rule', [{path: 'a', rule: 'nope', value: FIRST}]],
    ['no-literal', [{path: 'a', rule: 'host', value: 'https://forge.example/x.git'}]],
    ['bare-literal', [{path: 'a', rule: 'host', value: FAKE.privateHost}]],
    ['padded-literal', [{path: 'a', rule: 'host', value: ` ${FAKE.privateHost}\n`}]],
    ['empty-path', [{path: '', rule: 'host', value: FIRST}]],
    ['not-array', {path: 'a', rule: 'host', value: FIRST}],
  ] as const) {
    test(`a malformed entry (${name}) is a tool error`, () => {
      assert.equal(scanTree(scratch, privateList(name, allow)).status, 2);
    });
  }

  test('commits honours the entries; a later commit adding the value elsewhere is reported', () => {
    const root = initRepo('allow-commits');
    write(root, 'seed.txt', 'seed\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '--no-verify', '-m', `seed\n\n${TRAILER}`]);
    const base = git(root, ['rev-parse', 'HEAD']).trim();
    write(root, 'boot.sh', `pin ${FIRST}\npin ${SECOND}\n`);
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '--no-verify', '-m', `pins\n\n${TRAILER}`]);
    const list = privateList('commits', both);
    const commits = (range: string) => runCli(root, ['--no-secrets', '--private', list, 'commits', range], baseEnv());
    assert.equal(commits(`${base}..HEAD`).status, 0, commits(`${base}..HEAD`).output);
    write(root, 'readme.md', `${FIRST}\n`);
    git(root, ['add', '.']);
    assert.equal(runCli(root, ['--no-secrets', '--private', list, 'staged'], baseEnv()).status, 1);
    remove(path.dirname(root));
  });
});
