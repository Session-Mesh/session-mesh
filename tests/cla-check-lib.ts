// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Throwaway Git repositories for the tests of tools/cla-check/cla-check.ts. A pull request is a
// branch `pr` made from `main`. The checker is given what the CI job gives it: the base, the head of
// the pull request and the test merge commit GitHub builds from them (parent 1 the base, parent 2
// the head). This file does not import the checker, so the same scenarios can be replayed against
// another copy of it.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const CHECKER = path.join(ROOT, 'tools', 'cla-check', 'cla-check.ts');
export const MAINTAINERS_FILE = 'tools/cla-check/MAINTAINERS';
export const REGISTER_FILE = 'CLA-SIGNATORIES.md';

export type Person = {name: string; email: string};
export const MAINTAINER: Person = {name: 'Mathias Bourgoin', email: '5654071+mathiasbourgoin@users.noreply.github.com'};
export const ADA: Person = {name: 'Ada Example', email: '1001+ada@users.noreply.github.com'};
export const BOB: Person = {name: 'Bob Example', email: 'bob@example.com'};
export const EVE: Person = {name: 'Eve Example', email: '1003+eve@users.noreply.github.com'};
export const WEB: Person = {name: 'GitHub', email: 'noreply@github.com'};
export const HEADER = '# CLA signatories\n\n| Public name | Commit e-mail | CLA version | Date |\n|---|---|---|---|\n';
export const STAMP = '1763000000 +0000';

// Git isolated from the user's and the system's configuration (hooks, signing, templates).
export const GIT_ENV = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TEMPLATE_DIR: ''};

const roots: string[] = [];

export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
}

// With `emptyOnFailure`, a failing command gives '' instead of throwing.
export function git(repo: string, args: string[], env: Record<string, string> = {}, emptyOnFailure = false): string {
  try {
    return execFileSync('git', ['-C', repo, ...args], {env: {...GIT_ENV, ...env}, stdio: ['ignore', 'pipe', 'pipe']})
      .toString('utf8').trim();
  } catch (error) {
    if (emptyOnFailure) return '';
    throw error;
  }
}

export function row(person: Person, version = '1.0', date = '2026-11-20'): string {
  return `| ${person.name} | ${person.email} | ${version} | ${date} |\n`;
}

function identityEnv(author: Person, committer: Person): Record<string, string> {
  return {GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email};
}

export class Repo {
  readonly dir: string;
  base: string;

  // `main` starts with the register, the repository's own .gitattributes line for it (merge=union)
  // and the list of maintainers the checker reads at the base.
  constructor(registerAtBase = HEADER, extraFiles: Record<string, string> = {}) {
    this.dir = tempDir('cla-check-');
    git(this.dir, ['init', '-q', '-b', 'main']);
    this.commit(MAINTAINER, {'README.md': 'session-mesh\n', [REGISTER_FILE]: registerAtBase,
      '.gitattributes': fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'),
      [MAINTAINERS_FILE]: fs.readFileSync(path.join(ROOT, MAINTAINERS_FILE), 'utf8'), ...extraFiles});
    this.base = this.head();
    git(this.dir, ['checkout', '-q', '-b', 'pr']);
  }

  commit(author: Person, files: Record<string, string>, committer: Person = author): string {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(this.dir, name)), {recursive: true});
      fs.writeFileSync(path.join(this.dir, name), content);
    }
    git(this.dir, ['add', '-A']);
    git(this.dir, ['commit', '-q', '--no-verify', '--allow-empty', '-m', 'change'], identityEnv(author, committer));
    return this.head();
  }

  // A commit on `main` made after the pull request branched off: the base moves to it.
  commitOnMain(author: Person, files: Record<string, string>): string {
    git(this.dir, ['checkout', '-q', 'main']);
    this.base = this.commit(author, files);
    git(this.dir, ['checkout', '-q', 'pr']);
    return this.base;
  }

  // Starts the pull request branch again from the tip of `main`.
  restartFromMain(): void {
    git(this.dir, ['checkout', '-q', '-B', 'pr', 'main']);
  }

  // Merges `main` into the pull request branch, as its author would. With `register`, the merge
  // commit's own content for the register replaces what Git merged (an "evil merge").
  mergeMain(author: Person, register?: string): string {
    const env = identityEnv(author, author);
    if (register === undefined) {
      git(this.dir, ['merge', '-q', '--no-ff', '--no-edit', 'main'], env);
    } else {
      git(this.dir, ['merge', '-q', '--no-ff', '--no-commit', 'main'], env);
      fs.writeFileSync(path.join(this.dir, REGISTER_FILE), register);
      git(this.dir, ['add', '-A']);
      git(this.dir, ['commit', '-q', '--no-verify', '-m', 'merge main'], env);
    }
    return this.head();
  }

  // Brings the pull request up to date the way CONTRIBUTING.md asks: its commits replayed on the tip
  // of `main` (the register merged by the union driver of .gitattributes).
  rebaseOnMain(committer: Person): string {
    git(this.dir, ['rebase', '-q', 'main'], identityEnv(committer, committer));
    return this.head();
  }

  // A merge commit on the pull request branch: a side branch made from the base with one commit of
  // `author`, merged with `register` as the merge commit's own content for the register.
  mergeSideBranch(author: Person, register: string): string {
    const env = identityEnv(author, author);
    git(this.dir, ['checkout', '-q', '-b', 'side', this.base]);
    this.commit(author, {'side.txt': 'more\n'});
    git(this.dir, ['checkout', '-q', 'pr']);
    git(this.dir, ['merge', '-q', '--no-ff', '--no-commit', 'side'], env);
    fs.writeFileSync(path.join(this.dir, REGISTER_FILE), register);
    git(this.dir, ['add', '-A']);
    git(this.dir, ['commit', '-q', '--no-verify', '-m', 'merge side'], env);
    return this.head();
  }

  register(): string {
    return fs.readFileSync(path.join(this.dir, REGISTER_FILE), 'utf8');
  }

  head(): string {
    return git(this.dir, ['rev-parse', 'HEAD']);
  }

  tree(commit = 'HEAD'): string {
    return git(this.dir, ['rev-parse', `${commit}^{tree}`]);
  }

  // Writes a commit object from its raw text, however malformed, and returns its id.
  forge(text: string): string {
    const file = path.join(this.dir, '.git', 'forged');
    fs.writeFileSync(file, text);
    return git(this.dir, ['hash-object', '-t', 'commit', '--literally', '-w', file]);
  }

  // An ordinary commit header on top of the base, with the given author and committer fields.
  forgeOnBase(author: string, committer: string, tree = this.tree()): string {
    return this.forge(`tree ${tree}\nparent ${this.base}\nauthor ${author} ${STAMP}\ncommitter ${committer} ${STAMP}\n\nforged\n`);
  }

  // The test merge commit GitHub would build for the pull request: `head` merged into `base`, in
  // a separate work tree so that the .gitattributes of the base applies. When the head already
  // contains the base the result is the head's tree, written directly (this also covers forged
  // heads that `git merge` would refuse to read). Without a common ancestor (GitHub opens no such
  // pull request) it is also the head's tree, so that the checker sees the head anyway.
  testMerge(base = this.base, head = this.head()): string {
    const env = identityEnv(WEB, WEB);
    const common = git(this.dir, ['merge-base', base, head], {}, true);
    if (common === base || common === '') {
      return git(this.dir, ['commit-tree', '-p', base, '-p', head, '-m', 'test merge', this.tree(head)], env);
    }
    const tree = tempDir('cla-merge-');
    git(this.dir, ['worktree', 'add', '-q', '--detach', tree, base]);
    git(tree, ['merge', '-q', '--no-ff', '--no-edit', head], env);
    return git(tree, ['rev-parse', 'HEAD']);
  }
}
