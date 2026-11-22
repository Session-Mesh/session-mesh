// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// tools/cla-check/cla-check.ts on throwaway Git repositories (tests/cla-check-lib.ts): a pull request
// is a branch `pr` made from `main`; the checker gets the base, the head and the test merge commit of
// the two, as the CI job passes them. The attack scenarios are in tests/cla-check-merge.test.ts.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, test} from 'node:test';
import {checkPullRequest, parseRegister, report, type Result} from '../tools/cla-check/cla-check.ts';
import {ADA, BOB, CHECKER, GIT_ENV, HEADER, MAINTAINER, Repo, ROOT, WEB, git, removeTempDirs, row, tempDir} from './cla-check-lib.ts';

afterEach(removeTempDirs);

function result(repo: Repo): Result {
  return checkPullRequest(repo.dir, repo.base, repo.head(), repo.testMerge());
}

function offenders(repo: Repo): string[] {
  return result(repo).offenders.map((offender) => `${offender.email} ${offender.roles.join(',')}`);
}

// "<authors of the commits that make the change> <change> <address of the line>"
function violations(repo: Repo): string[] {
  return result(repo).violations.map((item) => `${item.by.map((made) => made.author).join(',')} ${item.change} ${item.email}`);
}

describe('CLA check', () => {
  test('accepts the code and the signature in the same commit', () => {
    const repo = new Repo();
    repo.commit(ADA, {'feature.txt': 'code\n', 'CLA-SIGNATORIES.md': repo.register() + row(ADA)});
    assert.deepEqual(offenders(repo), []);
  });

  test('accepts the signature in a separate commit of the same pull request', () => {
    const repo = new Repo();
    repo.commit(ADA, {'feature.txt': 'code\n'});
    repo.commit(ADA, {'CLA-SIGNATORIES.md': repo.register() + row(ADA)});
    repo.commit(ADA, {'feature.txt': 'more code\n'});
    assert.deepEqual(offenders(repo), []);
  });

  test('refuses a signature added by someone else, even a maintainer', () => {
    const repo = new Repo();
    repo.commit(MAINTAINER, {'CLA-SIGNATORIES.md': repo.register() + row(ADA)});
    repo.commit(ADA, {'feature.txt': 'code\n'});
    assert.deepEqual(violations(repo), [`${MAINTAINER.email} added ${ADA.email}`]);
  });

  test('refuses a maintainer\'s correction that changes the address of a line', () => {
    const repo = new Repo(HEADER + row(ADA));
    repo.commit(MAINTAINER, {'CLA-SIGNATORIES.md': HEADER + row({...ADA, email: 'ada@example.com'})});
    assert.deepEqual(violations(repo), [`${MAINTAINER.email} added ada@example.com`]);
  });

  test('accepts a contributor who removes their own line; their address is then unsigned', () => {
    const repo = new Repo(HEADER + row(ADA) + row(BOB));
    repo.commit(ADA, {'CLA-SIGNATORIES.md': HEADER + row(BOB)});
    assert.deepEqual(violations(repo), []);
    assert.deepEqual(offenders(repo), [`${ADA.email} author,committer`]);
  });

  test('accepts a maintainer who removes any line', () => {
    const repo = new Repo(HEADER + row(ADA) + row(BOB));
    repo.commit(MAINTAINER, {'CLA-SIGNATORIES.md': HEADER + row(BOB)});
    assert.deepEqual(violations(repo), []);
    assert.deepEqual(offenders(repo), []);
  });

  test('refuses a contributor without a signature', () => {
    const repo = new Repo();
    repo.commit(ADA, {'feature.txt': 'code\n'});
    assert.deepEqual(offenders(repo), [`${ADA.email} author,committer`]);
  });

  test('accepts a maintainer without a signature', () => {
    const repo = new Repo();
    repo.commit(MAINTAINER, {'feature.txt': 'code\n'});
    repo.commit({name: 'Julien Tesson', email: '142053968+julien-atacama@users.noreply.github.com'}, {'b.txt': 'b\n'});
    assert.deepEqual(offenders(repo), []);
  });

  test('refuses a different committer who has not signed', () => {
    const repo = new Repo();
    repo.commit(ADA, {'feature.txt': 'code\n', 'CLA-SIGNATORIES.md': repo.register() + row(ADA)}, BOB);
    assert.deepEqual(offenders(repo), [`${BOB.email} committer`]);
  });

  test('does not accept the queue-only maintainer alias on a pull request', () => {
    const repo = new Repo();
    repo.commit(MAINTAINER, {'a.txt': 'a\n'}, {name: 'mathiasbourgoin', email: 'mathiasbourgoin@users.noreply.github.com'});
    assert.deepEqual(offenders(repo), ['mathiasbourgoin@users.noreply.github.com committer']);
  });

  test('accepts GitHub as committer when the author has signed', () => {
    const repo = new Repo();
    repo.commit(ADA, {'feature.txt': 'code\n', 'CLA-SIGNATORIES.md': repo.register() + row(ADA)}, WEB);
    assert.deepEqual(offenders(repo), []);
  });

  test('refuses GitHub as committer when the author has not signed', () => {
    const repo = new Repo();
    repo.commit(ADA, {'feature.txt': 'code\n'}, WEB);
    assert.deepEqual(offenders(repo), [`${ADA.email} author`]);
  });

  test('refuses the GitHub address under another committer name', () => {
    const repo = new Repo();
    repo.commit(ADA, {'feature.txt': 'code\n', 'CLA-SIGNATORIES.md': repo.register() + row(ADA)},
      {name: 'Not GitHub', email: WEB.email});
    assert.deepEqual(offenders(repo), [`${WEB.email} committer`]);
  });

  test('accepts a signature already present at the base', () => {
    const repo = new Repo(HEADER + row(ADA));
    repo.commit(ADA, {'feature.txt': 'code\n'});
    assert.deepEqual(offenders(repo), []);
  });

  // .gitattributes sets `merge=union` on the register: a pull request that appends a line is
  // rebased on a `main` that gained another line without conflict, and keeps both rows.
  test('accepts a pull request rebased on a base branch that gained a line', () => {
    const repo = new Repo();
    repo.commit(ADA, {'CLA-SIGNATORIES.md': repo.register() + row(ADA)});
    repo.commitOnMain(BOB, {'CLA-SIGNATORIES.md': HEADER + row(BOB)});
    repo.rebaseOnMain(ADA);
    assert.equal(parseRegister(repo.register()).length, 2);
    assert.deepEqual(result(repo), {history: [], offenders: [], violations: []});
  });

  test('refuses a merge of the base branch into the pull request, even an honest one', () => {
    const repo = new Repo();
    repo.commit(ADA, {'CLA-SIGNATORIES.md': repo.register() + row(ADA)});
    repo.commitOnMain(BOB, {'CLA-SIGNATORIES.md': HEADER + row(BOB)});
    const merge = repo.mergeMain(ADA);
    assert.deepEqual(result(repo), {history: [{commit: merge, problem: 'merge'}], offenders: [], violations: []});
  });

  test('refuses a pull request whose branch is behind the base branch', () => {
    const repo = new Repo();
    repo.commit(ADA, {'CLA-SIGNATORIES.md': repo.register() + row(ADA)});
    repo.commitOnMain(BOB, {'feature.txt': 'code\n'});
    assert.deepEqual(result(repo).history, [{commit: repo.head(), problem: 'behind'}]);
  });

  test('accepts a branch behind the base branch when none of its commits changes the register', () => {
    const repo = new Repo(HEADER + row(ADA));
    repo.commit(ADA, {'feature.txt': 'code\n'});
    repo.commitOnMain(BOB, {'other.txt': 'main\n', 'CLA-SIGNATORIES.md': HEADER + row(ADA) + row(BOB)});
    assert.deepEqual(result(repo), {history: [], offenders: [], violations: []});
  });

  const asWeb = {GIT_AUTHOR_NAME: WEB.name, GIT_AUTHOR_EMAIL: WEB.email, GIT_COMMITTER_NAME: WEB.name, GIT_COMMITTER_EMAIL: WEB.email};

  // A head that main already contains: nothing of its own would land, and no tree was judged.
  test('refuses an empty range: a head that the base branch already contains', () => {
    const repo = new Repo(HEADER + row(ADA));
    const old: string = repo.base;
    repo.commitOnMain(ADA, {'feature.txt': 'code\n'});
    const merge = git(repo.dir, ['commit-tree', '-p', repo.base, '-p', old, '-m', 'test merge', repo.tree(repo.base)], asWeb);
    assert.deepEqual(checkPullRequest(repo.dir, repo.base, old, merge).history, [{commit: old, problem: 'behind'}]);
  });

  test('refuses, as unreadable, a test merge whose register is not the base\'s for a branch behind it', () => {
    const repo = new Repo(HEADER + row(ADA));
    repo.commit(ADA, {'feature.txt': 'code\n'});
    repo.commitOnMain(MAINTAINER, {'other.txt': 'main\n'});
    git(repo.dir, ['checkout', '-q', '-b', 'forged', repo.base]);
    const forgedTree = repo.tree(repo.commit(MAINTAINER, {'CLA-SIGNATORIES.md': HEADER + row(ADA) + row(BOB)}));
    const merge = git(repo.dir, ['commit-tree', '-p', repo.base, '-p', git(repo.dir, ['rev-parse', 'pr']), '-m', 'test merge', forgedTree], asWeb);
    const outcome = spawnSync(process.execPath, ['--experimental-strip-types', CHECKER, '--repo', repo.dir, '--base', repo.base,
      '--head', git(repo.dir, ['rev-parse', 'pr']), '--merge', merge], {env: GIT_ENV, encoding: 'utf8'});
    assert.equal(outcome.status, 2, outcome.stdout + outcome.stderr);
    assert.match(outcome.stderr, /does not hold the register of the base/);
  });

  test('reads only printable ASCII addresses in the register', () => {
    const rows = parseRegister(HEADER + row({name: 'K', email: 'Kay@example.com'}) + row({name: 'Z', email: 'z​@example.com'}) +
      row({name: 'N', email: 'n x@example.com'}) + row(ADA));
    assert.deepEqual(rows.map((item) => item.email), [ADA.email]);
  });

  // Ada's first line never reaches the base, so only the line the merge would add is reported; Ada's
  // commit is then unsigned as well.
  test('refuses when someone else rewrites the signatory line at head', () => {
    const repo = new Repo();
    repo.commit(ADA, {'CLA-SIGNATORIES.md': repo.register() + row(ADA)});
    repo.commit(BOB, {'CLA-SIGNATORIES.md': HEADER + row({...ADA, name: 'Someone Else'}) + row(BOB)});
    assert.deepEqual(violations(repo), [`${BOB.email} added ${ADA.email}`]);
  });

  test('refuses a signature that was removed again before head', () => {
    const repo = new Repo();
    repo.commit(ADA, {'feature.txt': 'code\n', 'CLA-SIGNATORIES.md': repo.register() + row(ADA)});
    repo.commit(ADA, {'CLA-SIGNATORIES.md': HEADER});
    assert.deepEqual(offenders(repo), [`${ADA.email} author,committer`]);
  });

  test('refuses a line naming an unknown CLA version', () => {
    const repo = new Repo();
    repo.commit(ADA, {'CLA-SIGNATORIES.md': repo.register() + row(ADA, '9.9')});
    assert.deepEqual(offenders(repo), [`${ADA.email} author,committer`]);
  });

  test('ignores a register that is a symbolic link', () => {
    const repo = new Repo();
    fs.writeFileSync(path.join(repo.dir, 'elsewhere.md'), HEADER + row(ADA));
    fs.rmSync(path.join(repo.dir, 'CLA-SIGNATORIES.md'));
    fs.symlinkSync('elsewhere.md', path.join(repo.dir, 'CLA-SIGNATORIES.md'));
    repo.commit(ADA, {'feature.txt': 'code\n'});
    assert.deepEqual(offenders(repo), [`${ADA.email} author,committer`]);
  });

  test('compares addresses without regard to case', () => {
    const repo = new Repo();
    repo.commit({...ADA, email: ADA.email.toUpperCase()}, {'CLA-SIGNATORIES.md': repo.register() + row(ADA)});
    assert.deepEqual(offenders(repo), []);
  });

  test('parses only well-formed rows', () => {
    const rows = parseRegister(HEADER + row(ADA) + '| no address | x | 1.0 | 2026-11-20 |\n| a | `b@example.com` | 1.0 | 2026-11-20 |\n');
    assert.deepEqual(rows.map((item) => item.email), [ADA.email, 'b@example.com']);
  });

  test('ignores rows inside a fenced code block; the register\'s own example is not a row either', () => {
    assert.deepEqual(parseRegister('```text\n' + row(ADA) + '```\n' + row(BOB)).map((item) => item.email), [BOB.email]);
    const committed = fs.readFileSync(path.join(ROOT, 'CLA-SIGNATORIES.md'), 'utf8');
    assert.deepEqual(parseRegister(committed.replace(/```/g, '')), parseRegister(committed));
  });

  test('the failure report names only the refused addresses and where to read the CLA', () => {
    const text = report({history: [{commit: 'b'.repeat(40), problem: 'merge'}, {commit: 'c'.repeat(40), problem: 'root'}],
      offenders: [{email: 'x@example.com\u001b[31m', roles: ['author', 'committer']}],
      violations: [{email: '::warning x', change: 'added', by: [{commit: 'a'.repeat(40), author: 'y@example.com\u001b'}]},
        {email: '::error y', change: 'removed', by: []}]});
    assert.match(text, /^CLA check failed: rebase your branch on main; merge commits are not allowed in a pull request\.$/m);
    assert.match(text, /^ {2}- commit b{12} is a merge commit$/m);
    assert.match(text, /^ {2}- commit c{12} has no parent$/m);
    assert.match(text, /^ {2}- the merge adds a line for ::warning x, added by commit a{12} \(author y@example\.com\?\)$/m);
    assert.match(text, /^ {2}- the merge removes or changes the line of ::error y, removed by no commit of the pull request$/m);
    assert.match(text, /^ {2}- x@example\.com\?\[31m \(author, committer\)$/m);
    assert.match(text, /CLA\.md/);
    assert.doesNotMatch(text, /\u001b/);
    assert.ok(text.split('\n').every((line) => !line.startsWith('::')), 'no line may be read as a workflow command');
  });
});

describe('CLA check command line', () => {
  function run(checker: string, args: string[]) {
    return spawnSync(process.execPath, ['--experimental-strip-types', checker, ...args], {env: GIT_ENV, encoding: 'utf8'});
  }

  function args(repo: Repo): string[] {
    return ['--repo', repo.dir, '--base', repo.base, '--head', repo.head(), '--merge', repo.testMerge()];
  }

  test('a copy outside the repository (as CI runs it) exits 0 when accepted, 1 when refused', () => {
    const repo = new Repo();
    const copy = path.join(tempDir('cla-checker-'), 'cla-check.ts');
    fs.copyFileSync(CHECKER, copy);
    repo.commit(ADA, {'feature.txt': 'code\n', 'CLA-SIGNATORIES.md': repo.register() + row(ADA)});
    const accepted = run(copy, args(repo));
    assert.equal(accepted.status, 0, accepted.stderr);
    repo.commit(BOB, {'other.txt': 'code\n'});
    const refused = run(copy, args(repo));
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stdout, /- bob@example\.com \(author, committer\)/);
  });

  test('treats hostile names and file contents as data', () => {
    const repo = new Repo();
    const marker = path.join(repo.dir, 'pwned');
    const hostile = {name: `$(touch ${marker}) \`touch ${marker}\``, email: 'eve@example.com'};
    repo.commit(hostile, {'CLA-SIGNATORIES.md': repo.register() + `| $(touch ${marker}) | eve@example.com | 1.0 | 2026-11-20 |\n`});
    const result = run(CHECKER, args(repo));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(marker), false);
  });

  // Who may change the register: an added line carries its commit's author address; a removed or
  // changed line is its holder's or a maintainer's doing.
  function check(repo: Repo) {
    return run(CHECKER, args(repo));
  }

  test('refuses a signatory who adds a line for someone else', () => {
    const repo = new Repo(HEADER + row(ADA));
    repo.commit(ADA, {'feature.txt': 'code\n', 'CLA-SIGNATORIES.md': repo.register() + row(BOB)});
    const result = check(repo);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /adds a line for bob@example\.com/);
  });

  test('refuses a signatory who removes the line of someone else', () => {
    const repo = new Repo(HEADER + row(ADA) + row(BOB));
    repo.commit(ADA, {'CLA-SIGNATORIES.md': HEADER + row(ADA)});
    const result = check(repo);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /removes or changes the line of bob@example\.com/);
  });

  test('accepts a signatory who changes their own line', () => {
    const repo = new Repo(HEADER + row(ADA) + row(BOB));
    repo.commit(ADA, {'CLA-SIGNATORIES.md': HEADER + row({...ADA, name: 'Ada Renamed'}) + row(BOB)});
    const result = check(repo);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test('accepts a maintainer who corrects a line, keeping its address', () => {
    const repo = new Repo(HEADER + row({...ADA, name: 'Ada Exmaple'}) + row(BOB));
    repo.commit(MAINTAINER, {'CLA-SIGNATORIES.md': HEADER + row(ADA) + row(BOB)});
    const result = check(repo);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test('refuses an author header that holds more than one address', () => {
    const repo = new Repo(HEADER + row(ADA));
    const id = repo.forgeOnBase(`Eve <eve@example.com> <${ADA.email}>`, `${ADA.name} <${ADA.email}>`);
    git(repo.dir, ['update-ref', 'refs/heads/pr', id]);
    const result = check(repo);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /more than one address/);
  });

  test('refuses a merge commit that is not the merge of the given base and head', () => {
    const repo = new Repo(HEADER + row(ADA));
    repo.commit(ADA, {'feature.txt': 'code\n'});
    const merge = repo.testMerge();
    repo.commit(BOB, {'other.txt': 'code\n'});
    const stale = run(CHECKER, ['--repo', repo.dir, '--base', repo.base, '--head', repo.head(), '--merge', merge]);
    assert.equal(stale.status, 2, stale.stdout + stale.stderr);
    assert.match(stale.stderr, /the base and the head as its two parents/);
    const missing = run(CHECKER, ['--repo', repo.dir, '--base', repo.base, '--head', repo.head()]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /usage/);
  });

  test('refuses anything but full object ids, without running git on them', () => {
    const repo = new Repo();
    const result = run(CHECKER, ['--repo', repo.dir, '--base', '--upload-pack=touch x', '--head', 'HEAD', '--merge', repo.head()]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /full object ids/);
  });
});
