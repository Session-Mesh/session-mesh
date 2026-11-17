// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// tools/cla-check/MAINTAINERS is the only place that holds the maintainers' commit addresses. The
// "Maintainers" list of CONTRIBUTORS.md (the one CLA.md refers to) and the accounts of
// .github/CODEOWNERS name the same people: the three change together.
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, test} from 'node:test';
import {MAINTAINERS_FILE, parseMaintainers} from '../tools/cla-check/cla-check.ts';
import {ADA, CHECKER, GIT_ENV, HEADER, Repo, ROOT, git, removeTempDirs} from './cla-check-lib.ts';

afterEach(removeTempDirs);

const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');
const entries = read(MAINTAINERS_FILE).split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'))
  .map((line) => /^(.+) <(\d+\+([A-Za-z0-9-]+)@users\.noreply\.github\.com)>$/.exec(line));

describe('the list of maintainers', () => {
  test('every entry is a name and a GitHub noreply address, which the checker reads', () => {
    assert.ok(entries.length > 0 && entries.every(Boolean), 'each line is: Name <ID+login@users.noreply.github.com>');
    assert.deepEqual([...parseMaintainers(read(MAINTAINERS_FILE))].sort(), entries.map((entry) => entry![2].toLowerCase()).sort());
  });

  test('names the people of the "Maintainers" list of CONTRIBUTORS.md', () => {
    const section = /^## Maintainers\n([\s\S]*?)^## /m.exec(read('CONTRIBUTORS.md'))?.[1] ?? '';
    const listed = [...section.matchAll(/^- (.+)$/gm)].map((match) => match[1].trim());
    assert.deepEqual(entries.map((entry) => entry![1]).sort(), listed.sort());
  });

  test('has the accounts .github/CODEOWNERS gives every protected path, the checker\'s directory included', () => {
    const logins = entries.map((entry) => `@${entry![3]}`).sort();
    const rules = read('.github/CODEOWNERS').split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
    assert.ok(rules.some((rule) => rule.split(/\s+/)[0] === '/tools/cla-check/'));
    for (const rule of rules) assert.deepEqual(rule.split(/\s+/).slice(1).sort(), logins, rule);
  });

  // The files that get published: the tracked ones, less the paths the public tree assembly leaves
  // out (listed in a file that is itself left out, so absent from the public tree). Untracked local
  // files are never published, and a tree outside git (an unpacked archive) has no tracked files.
  const inGit = spawnSync('git', ['-C', ROOT, 'rev-parse', '--is-inside-work-tree'], {encoding: 'utf8'}).stdout?.trim() === 'true';
  const ASSEMBLY_EXCLUDE = 'tools/public-export/assembly-exclude.txt';
  const unpublished = fs.existsSync(path.join(ROOT, ASSEMBLY_EXCLUDE))
    ? read(ASSEMBLY_EXCLUDE).split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
    : [];
  test('no other published file of the repository (tests aside) holds a maintainer address',
    {skip: !inGit && 'not a git repository: no tracked files to search'}, () => {
      const addresses = entries.map((entry) => entry![2]);
      const holders = execFileSync('git', ['-C', ROOT, 'grep', '-l', '-F', ...addresses.flatMap((address) => ['-e', address]), '--',
        '.', ':!tests/', ...unpublished.map((entry) => `:!${entry}`)], {encoding: 'utf8'}).split('\n').filter(Boolean);
      assert.deepEqual(holders, [MAINTAINERS_FILE]);
    });

  test('the checker stops (exit 2) when the base has no list, or an unreadable one', () => {
    for (const content of [null, 'not a maintainer line\n', '# nobody\n']) {
      const repo = new Repo(HEADER);
      if (content === null) fs.rmSync(path.join(repo.dir, MAINTAINERS_FILE));
      else fs.writeFileSync(path.join(repo.dir, MAINTAINERS_FILE), content);
      git(repo.dir, ['checkout', '-q', 'main']);
      repo.base = repo.commit(ADA, {});
      repo.restartFromMain();
      repo.commit(ADA, {'feature.txt': 'code\n'});
      const run = spawnSync(process.execPath, ['--experimental-strip-types', CHECKER, '--repo', repo.dir, '--base', repo.base,
        '--head', repo.head(), '--merge', repo.testMerge()], {env: GIT_ENV, encoding: 'utf8'});
      assert.equal(run.status, 2, run.stdout + run.stderr);
      assert.match(run.stderr, /MAINTAINERS/);
    }
  });
});
