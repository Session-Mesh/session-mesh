// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Hooks run in a temporary repository; leak-guard's hooks are declared in Git configuration.
// When this tree carries roster's telemetry hooks (.harness/), they are installed first through
// `core.hooksPath`, and the roster assertions check that both sets of hooks coexist. Without
// .harness/ (the published tree), every leak-guard case still runs and only the roster
// assertions are skipped.
// Git older than 2.54 has no hooks declared in configuration: the cases that need git to run them
// are skipped with that reason, and the last suite checks what the tool says to such a git.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {after, before, describe, test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {MIN_GIT, gitVersion} from '../tools/leak-guard/hooks.ts';
import {FAKE, REPO, TRAILER, baseEnv, git, initRepo, remove, runCli, tryGit, write, writePrivateList} from './leak-guard-fixtures.ts';

const ROSTER_FILES = ['.harness/harness.json', '.harness/telemetry.json', '.harness/bin/roster-telemetry.cjs', '.harness/bin/package.json'];
// The coordination directory .harness/ is not part of the published tree.
const ROSTER_PRESENT = ROSTER_FILES.every((file) => fs.existsSync(path.join(REPO, file)));
const ROSTER_ABSENT_REASON = 'no .harness/ directory here (commit hooks of Roster, a development tool this project does not ship): ' +
  'coexistence with those hooks not tested';
const GIT = gitVersion(REPO);
const OLD_GIT_REASON = `git ${GIT.text} has no hooks declared in configuration (Git ${MIN_GIT.join('.')} or later)`;
const CONFIG_HOOKS = {skip: GIT.supported ? false : OLD_GIT_REASON};
const ROSTER_ONLY = {skip: ROSTER_PRESENT ? false : ROSTER_ABSENT_REASON};
const ROSTER_AND_CONFIG_HOOKS = {skip: ROSTER_ONLY.skip || CONFIG_HOOKS.skip};
// Roster's install turns on extensions.worktreeConfig, so leak-guard then writes its keys to the
// worktree configuration; in a plain repository they go to the local one.
const SCOPE = ROSTER_PRESENT ? 'worktree' : 'local';
let root = '';
let env = baseEnv();
let hooksPathBefore = '';
let digestBefore = '';

function roster(action: string) {
  const run = spawnSync(process.execPath, ['.harness/bin/roster-telemetry.cjs', action, '--root', root], {cwd: root, env, encoding: 'utf8'});
  return {status: run.status, json: run.status === 0 ? JSON.parse(run.stdout) : null, stderr: run.stderr};
}

// Content digest of every file under .harness/ (names, bytes and modes).
function harnessDigest(): string {
  const hash = createHash('sha256');
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else hash.update(`${path.relative(root, file)}\0${fs.statSync(file).mode}\0`).update(fs.readFileSync(file));
    }
  };
  visit(path.join(root, '.harness'));
  return hash.digest('hex');
}

// Roster stays installed and active, its files unchanged; a no-op without roster.
function assertRosterUntouched(): void {
  if (!ROSTER_PRESENT) return;
  assert.equal(harnessDigest(), digestBefore, 'nothing written under .harness/');
  assert.equal(roster('status').json.active, true, 'roster telemetry stays active');
}

// core.hooksPath, or '' when it is not set (no roster hooks).
function hooksPath(): string {
  return tryGit(root, ['config', '--get', 'core.hooksPath'], env).stdout.trim();
}

function commitCount(): number {
  const run = tryGit(root, ['rev-list', '--count', 'HEAD'], env);
  return run.status === 0 ? Number(run.stdout.trim()) : 0;
}

function commit(message: string, extraEnv: Record<string, string> = {}) {
  return tryGit(root, ['commit', '-q', '--allow-empty', '-m', message], {...env, ...extraEnv});
}

before(() => {
  root = initRepo('hooks');
  env = baseEnv({MESH_LEAK_GITLEAKS: path.join(root, 'no-gitleaks')});
  if (ROSTER_PRESENT) {
    for (const file of ROSTER_FILES) write(root, file, fs.readFileSync(path.join(REPO, file)));
    assert.equal(roster('install').status, 0, 'roster telemetry installs in the temporary repository');
    digestBefore = harnessDigest();
  }
  hooksPathBefore = hooksPath();
});
after(() => remove(path.dirname(root)));

describe('leak-guard hooks, beside roster when it is present', () => {
  test('roster telemetry is active before installation', ROSTER_ONLY, () => {
    assert.equal(roster('status').json.active, true);
    assert.equal(hooksPathBefore, path.join(fs.realpathSync(root), '.harness/git-hooks'));
  });
  test('status before installation says not active (exit 1)', () => {
    const run = runCli(root, ['hooks', 'status'], env);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /NOT active/);
  });
  test('install prints every key it writes and leaves roster untouched', CONFIG_HOOKS, () => {
    const privateFile = writePrivateList(path.dirname(root));
    const run = runCli(root, ['hooks', 'install', '--private', privateFile], env);
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, new RegExp(`wrote \\(${SCOPE}\\) hook\\.session-mesh-leaks-staged\\.event = pre-commit`));
    assert.match(run.stdout, new RegExp(`wrote \\(${SCOPE}\\) hook\\.session-mesh-leaks-msg\\.command = `));
    assert.equal(hooksPath(), hooksPathBefore);
    assertRosterUntouched();
    if (ROSTER_PRESENT) {
      assert.equal(roster('install').status, 0, 'a later roster update reports no hook conflict');
      assert.equal(harnessDigest(), digestBefore);
    }
  });
  test('status lists both hooks and git runs roster hooks too', CONFIG_HOOKS, () => {
    const run = runCli(root, ['hooks', 'status'], env);
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, /session-mesh-leaks-staged \(pre-commit\): registered/);
    const list = git(root, ['hook', 'list', 'commit-msg'], env);
    assert.match(list, /session-mesh-leaks-msg/);
    if (ROSTER_PRESENT) assert.match(list, /hookdir/);
  });
  test('a message without any trailer passes', CONFIG_HOOKS, () => {
    const count = commitCount();
    const run = commit('add nothing');
    assert.equal(run.status, 0, run.stderr);
    assert.equal(commitCount(), count + 1);
  });
  test('an agent co-author line passes', CONFIG_HOOKS, () => {
    const run = commit(`fix\n\nCo-Authored-By: Claude <1+claude${'@'}users.noreply.github.com>`);
    assert.equal(run.status, 0, run.stderr);
  });
  test('an agent session trailer is still refused', CONFIG_HOOKS, () => {
    const run = commit('fix\n\nclaude-session: 0123abcd');
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /agent-session-trailer/);
  });
  test('a non-noreply author identity is refused', CONFIG_HOOKS, () => {
    const run = commit(`fix\n\n${TRAILER}`, {GIT_AUTHOR_EMAIL: FAKE.email});
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /identity-not-noreply/);
  });
  test('a staged leak from the private list is refused by pre-commit', CONFIG_HOOKS, () => {
    write(root, 'notes.md', `deploy on ${FAKE.privateHost}\n`);
    git(root, ['add', 'notes.md'], env);
    const run = commit(`notes\n\n${TRAILER}`);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /hook pre-commit: 1 finding/);
    assert.match(run.stderr, /private:host/);
    git(root, ['rm', '-q', '--cached', 'notes.md'], env);
    fs.rmSync(path.join(root, 'notes.md'));
  });
  test('a leak on a comment line that git commit -m keeps is refused (B1)', CONFIG_HOOKS, () => {
    const count = commitCount();
    const run = commit(`notes\n\n# ${FAKE.privateHost}\n\n${TRAILER}`);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /private:host/);
    assert.equal(commitCount(), count);
  });
  test('a leak below a scissors line that git commit -F keeps is refused (B1)', CONFIG_HOOKS, () => {
    const file = path.join(path.dirname(root), 'message.txt');
    fs.writeFileSync(file, `notes\n\n${TRAILER}\n# ------------------------ >8 ------------------------\n${FAKE.email}\n`);
    const run = tryGit(root, ['commit', '-q', '--allow-empty', '-F', file], env);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /\] email/);
  });
  test('git\'s own verbose cut line still ends what the hook reads (removed lines below it pass)', CONFIG_HOOKS, () => {
    const editor = path.join(path.dirname(root), 'editor.sh');
    fs.writeFileSync(editor, `#!/bin/sh\nprintf 'docs: verbose\\n\\n${TRAILER}\\n' | cat - "$1" > "$1.new" && mv "$1.new" "$1"\n`, {mode: 0o755});
    write(root, 'old.txt', `${FAKE.email}\nkeep\n`);
    git(root, ['add', 'old.txt'], env);
    git(root, ['commit', '-q', '--no-verify', '-m', `seed\n\n${TRAILER}`], env);
    write(root, 'old.txt', 'keep\n');
    git(root, ['add', 'old.txt'], env);
    const run = tryGit(root, ['commit', '-q', '-v'], {...env, GIT_EDITOR: editor});
    assert.equal(run.status, 0, run.stderr);
  });
  test('a clean commit passes through both leak-guard and roster hooks', CONFIG_HOOKS, () => {
    const count = commitCount();
    write(root, 'readme.txt', 'hello\n');
    git(root, ['add', 'readme.txt'], env);
    const run = commit(`docs: add readme\n\n${TRAILER}`);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(commitCount(), count + 1);
    if (ROSTER_PRESENT) assert.equal(roster('status').json.active, true);
  });
  test('roster commit-msg still blocks on its own (both hooks run, either refusal blocks)', ROSTER_AND_CONFIG_HOOKS, () => {
    const hook = path.join(root, '.harness/git-hooks/commit-msg');
    const original = fs.readFileSync(hook);
    fs.writeFileSync(hook, '#!/bin/sh\necho roster-probe-refusal >&2\nexit 1\n');
    try {
      const run = commit(`docs: second\n\n${TRAILER}`);
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /hook commit-msg: 0 finding/);
      assert.match(run.stderr, /roster-probe-refusal/);
    } finally {
      fs.writeFileSync(hook, original);
    }
  });
  test('uninstall removes both keys and says so; roster stays active', CONFIG_HOOKS, () => {
    const run = runCli(root, ['hooks', 'uninstall'], env);
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, new RegExp(`removed \\(${SCOPE}\\) hook\\.session-mesh-leaks-staged`));
    assert.match(runCli(root, ['hooks', 'uninstall'], env).stdout, new RegExp(`not installed \\(${SCOPE}\\)`));
    if (ROSTER_PRESENT) assert.equal(roster('status').json.active, true);
    assert.equal(hooksPath(), hooksPathBefore);
  });
});

// Runs with any git: a wrapper first on PATH answers `git version` as Ubuntu 24.04's git does.
describe('leak-guard hooks with a git older than 2.54', () => {
  let oldRoot = '';
  let oldEnv = baseEnv();
  before(() => {
    oldRoot = initRepo('hooks-old-git');
    const bin = path.join(path.dirname(oldRoot), 'bin');
    const realGit = spawnSync('sh', ['-c', 'command -v git'], {encoding: 'utf8'}).stdout.trim();
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n[ "$1" = version ] && { echo 'git version 2.43.0'; exit 0; }\nexec '${realGit}' "$@"\n`, {mode: 0o755});
    oldEnv = baseEnv({PATH: `${bin}:${process.env.PATH}`});
  });
  after(() => remove(path.dirname(oldRoot)));

  test('install refuses, names the versions and writes no key', () => {
    const run = runCli(oldRoot, ['hooks', 'install'], oldEnv);
    assert.equal(run.status, 2, run.output);
    assert.match(run.stderr, /git 2\.43\.0 is too old for the leak-guard hooks/);
    assert.match(run.stderr, /Git 2\.54 or later/);
    assert.match(run.stderr, /NOT checked locally/);
    assert.match(run.stderr, /Nothing was written/);
    assert.equal(tryGit(oldRoot, ['config', '--get-regexp', '^hook\\.'], oldEnv).stdout, '');
  });
  test('status says not active and why (exit 1)', () => {
    const run = runCli(oldRoot, ['hooks', 'status'], oldEnv);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /leak-guard hooks: NOT active \(git 2\.43\.0 is too old/);
    assert.doesNotMatch(run.stdout, /run: hooks install/);
  });
});
