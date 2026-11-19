// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Attack and control scenarios for the CLA check, each a pull request built on a throwaway
// repository with the exit status the checker must give: 0 accepted, 1 refused, 2 unreadable.
// The ids are stable keys. S6b, S7, S8b, S9i, S17, S19 and S20 were accepted by an earlier checker that judged
// each commit against its parents and read the register at the head of the pull request; R1, R2, D1 and D2 by
// the one that admitted merge commits.
// `reason`, when given, must appear in the checker's output.
import fs from 'node:fs';
import path from 'node:path';
import {ADA, BOB, EVE, HEADER, MAINTAINER, type Person, REGISTER_FILE, Repo, STAMP, WEB, git, row} from './cla-check-lib.ts';

export type Built = {repo: Repo; base: string; head: string};
export type Scenario = {id: string; title: string; expected: 0 | 1 | 2; reason?: RegExp; build: () => Built};

const REG = REGISTER_FILE;
const built = (repo: Repo, head = repo.head()): Built => ({repo, base: repo.base, head});
const who = (person: Person): string => `${person.name} <${person.email}>`;

function simple(registerAtBase: string, change: (repo: Repo) => void): () => Built {
  return () => {
    const repo = new Repo(registerAtBase);
    change(repo);
    return built(repo);
  };
}

function forged(author: string, committer = author): () => Built {
  return () => {
    const repo = new Repo(HEADER + row(ADA));
    repo.commit(EVE, {'feature.txt': 'code\n'});
    return built(repo, repo.forgeOnBase(author, committer));
  };
}

const REGISTER_CHANGES: Scenario[] = [
  {id: 'S1', title: 'a signatory adds a line for a third party', expected: 1,
    build: simple(HEADER + row(ADA), (repo) => repo.commit(ADA, {[REG]: HEADER + row(ADA) + row(BOB)}))},
  {id: 'S2', title: 'a maintainer adds a line for a third party', expected: 1,
    build: simple(HEADER, (repo) => repo.commit(MAINTAINER, {[REG]: HEADER + row(BOB)}))},
  {id: 'S3a', title: 'a signatory removes another line', expected: 1,
    build: simple(HEADER + row(ADA) + row(BOB), (repo) => repo.commit(ADA, {[REG]: HEADER + row(ADA)}))},
  {id: 'S3b', title: 'a signatory renames another line', expected: 1,
    build: simple(HEADER + row(ADA) + row(BOB),
      (repo) => repo.commit(ADA, {[REG]: HEADER + row(ADA) + row({...BOB, name: 'Bobby'})}))},
  {id: 'S3c', title: 'a signatory hides another line in a code fence', expected: 1,
    build: simple(HEADER + row(ADA) + row(BOB),
      (repo) => repo.commit(ADA, {[REG]: HEADER + row(ADA) + '```\n' + row(BOB) + '```\n'}))},
  {id: 'S3d', title: 'a signatory replaces the register by a symbolic link', expected: 1,
    build: simple(HEADER + row(ADA) + row(BOB), (repo) => {
      fs.rmSync(path.join(repo.dir, REG));
      fs.symlinkSync('README.md', path.join(repo.dir, REG));
      repo.commit(ADA, {});
    })},
  {id: 'S3e', title: 'a signatory hides another line in an HTML comment', expected: 1,
    build: simple(HEADER + row(ADA) + row(BOB),
      (repo) => repo.commit(ADA, {[REG]: HEADER + row(ADA) + '<!--\n' + row(BOB) + '-->\n'}))},
  {id: 'S4', title: 'the signature in the commit of the contribution', expected: 0,
    build: simple(HEADER, (repo) => repo.commit(ADA, {'f': 'code\n', [REG]: HEADER + row(ADA)}))},
  {id: 'S5a', title: 'unsigned commits only', expected: 1,
    build: simple(HEADER, (repo) => repo.commit(ADA, {'f': 'code\n'}))},
  {id: 'S5b', title: 'the signature after the unsigned commits', expected: 0,
    build: simple(HEADER, (repo) => {
      repo.commit(ADA, {'f': 'code\n'});
      repo.commit(ADA, {[REG]: HEADER + row(ADA)});
    })},
  {id: 'S11', title: 'the register replaced by a symbolic link to a signed file', expected: 1,
    build: simple(HEADER, (repo) => {
      fs.rmSync(path.join(repo.dir, REG));
      fs.symlinkSync('other.md', path.join(repo.dir, REG));
      repo.commit(EVE, {'other.md': HEADER + row(EVE)});
    })},
  {id: 'S17', title: 'own line inside an HTML comment, above the table', expected: 1,
    build: simple(HEADER, (repo) => repo.commit(EVE, {'f': 'code\n', [REG]: '<!--\n' + row(EVE) + '-->\n' + HEADER}))},
  {id: 'S17b', title: 'own line after a one-line HTML comment opener', expected: 1,
    build: simple(HEADER, (repo) => repo.commit(EVE, {'f': 'code\n', [REG]: HEADER + '<!-- x --> <!--\n' + row(EVE) + '-->\n'}))},
  {id: 'S17c', title: 'own line indented as a code block', expected: 1,
    build: simple(HEADER, (repo) => repo.commit(EVE, {'f': 'code\n', [REG]: HEADER + '\n    ' + row(EVE)}))},
  {id: 'S20', title: 'a line with an impossible date', expected: 1,
    build: simple(HEADER, (repo) => repo.commit(EVE, {'f': 'code\n', [REG]: HEADER + row(EVE, '1.0', '9999-99-99')}))},
  {id: 'S20b', title: 'a line dated 30 February', expected: 1,
    build: simple(HEADER, (repo) => repo.commit(EVE, {'f': 'code\n', [REG]: HEADER + row(EVE, '1.0', '2026-02-30')}))},
  // Addresses are printable ASCII: no look-alike of a signed address, no letter that case folding
  // turns into an ASCII one.
  {id: 'D1', title: 'an author address with a Kelvin sign that lower-cases to a signed k', expected: 1,
    build: simple(HEADER + row({name: 'Kay', email: 'kay@example.com'}),
      (repo) => repo.commit({name: 'Eve', email: 'Kay@example.com'}, {'f': 'code\n'}))},
  {id: 'D2', title: 'a signature whose address hides a zero-width space', expected: 1,
    build: simple(HEADER, (repo) => {
      const lookalike = {name: 'Bob Example', email: 'bob​@example.com'};
      repo.commit(lookalike, {'f': 'code\n', [REG]: HEADER + row(lookalike)});
    })},
  {id: 'R3', title: 'control: a linear pull request on the tip of main', expected: 0,
    build: simple(HEADER + row(BOB), (repo) => {
      repo.commit(EVE, {[REG]: HEADER + row(BOB) + row(EVE), 'f': 'code\n'});
      repo.commit(EVE, {'f': 'code2\n'});
    })},
];

// Pull requests are integrated by "Rebase and merge", which drops merge commits: a pull request
// must be a straight line of ordinary commits on top of the tip of `main` (SPEC.md, rule 0).
const MERGE_COMMIT = /rebase your branch on main; merge commits are not allowed in a pull request/;
const BEHIND = /is not up to date with main: update it by rebasing it on main/;
const ROOT_COMMIT = /commits without a parent are not allowed in a pull request/;

// A branch made before `main` moved, with Ada's line added in its commit.
function branchBehindMain(registerAtBase: string, adaCommit: string, onMain: Record<string, string>,
  holder: Person = BOB): Repo {
  const repo = new Repo(registerAtBase);
  repo.commit(ADA, {'f': 'code\n', [REG]: adaCommit});
  repo.commitOnMain(holder, onMain);
  return repo;
}

// R1, R2: what a merge commit of the pull request undoes in the judged tree, "Rebase and merge"
// would land: the ordinary commit's change to the register.
function hiddenByMergeCommit(change: string, restored: string): () => Built {
  return () => {
    const repo = new Repo(HEADER + row(BOB));
    repo.commit(EVE, {[REG]: change, 'feature.txt': 'code\n'});
    repo.mergeSideBranch(EVE, restored);
    return built(repo);
  };
}

const MERGES: Scenario[] = [
  {id: 'R1', title: 'a commit removes a third party line, a merge commit puts it back', expected: 1, reason: MERGE_COMMIT,
    build: hiddenByMergeCommit(HEADER + row(EVE), HEADER + row(BOB) + row(EVE))},
  {id: 'R2', title: 'a commit adds a line for a third party, a merge commit removes it', expected: 1, reason: MERGE_COMMIT,
    build: hiddenByMergeCommit(HEADER + row(ADA) + row(BOB) + row(EVE), HEADER + row(BOB) + row(EVE))},
  {id: 'S6a', title: 'a stale branch still carrying a line its holder withdrew on main', expected: 1, reason: BEHIND,
    build: () => built(branchBehindMain(HEADER + row(BOB), HEADER + row(ADA) + row(BOB), {[REG]: HEADER}))},
  {id: 'S6b', title: 'a union merge of main brings back a line its holder withdrew', expected: 1, reason: MERGE_COMMIT,
    build: () => {
      const repo = branchBehindMain(HEADER + row(BOB), HEADER + row(ADA) + row(BOB), {[REG]: HEADER});
      repo.mergeMain(ADA);
      return built(repo);
    }},
  // The same branch brought up to date by a rebase: the union driver keeps Bob's withdrawn line in
  // Ada's replayed commit, which then adds a line that is not hers.
  {id: 'S6c', title: 'a rebase on main brings back a line its holder withdrew', expected: 1,
    reason: /adds a line for bob@example\.com/,
    build: () => {
      const repo = branchBehindMain(HEADER + row(BOB), HEADER + row(ADA) + row(BOB), {[REG]: HEADER});
      repo.rebaseOnMain(ADA);
      return built(repo);
    }},
  {id: 'S7', title: 'a merge commit of main drops a third party line', expected: 1, reason: MERGE_COMMIT,
    build: () => {
      const repo = new Repo(HEADER);
      repo.commit(EVE, {'f': 'code\n', [REG]: HEADER + row(EVE)});
      repo.commitOnMain(BOB, {[REG]: HEADER + row(BOB)});
      repo.mergeMain(EVE, HEADER + row(EVE));
      return built(repo);
    }},
  {id: 'S7r', title: 'after a rebase on main, a commit drops a third party line', expected: 1,
    reason: /removes or changes the line of bob@example\.com/,
    build: () => {
      const repo = new Repo(HEADER);
      repo.commitOnMain(BOB, {[REG]: HEADER + row(BOB)});
      repo.restartFromMain();
      repo.commit(EVE, {'f': 'code\n', [REG]: HEADER + row(EVE)});
      return built(repo);
    }},
  {id: 'S7b', title: 'a merge commit of main adds a line for a third party', expected: 1, reason: MERGE_COMMIT,
    build: () => {
      const repo = new Repo(HEADER);
      repo.commit(ADA, {'f': 'code\n', [REG]: HEADER + row(ADA)});
      repo.commitOnMain(MAINTAINER, {'g': 'main\n'});
      repo.mergeMain(ADA, HEADER + row(ADA) + row(BOB));
      return built(repo);
    }},
  {id: 'S7c', title: 'an honest union merge of main, both lines kept, is still a merge commit', expected: 1,
    reason: MERGE_COMMIT,
    build: () => {
      const repo = branchBehindMain(HEADER, HEADER + row(ADA), {[REG]: HEADER + row(BOB)});
      repo.mergeMain(ADA);
      return built(repo);
    }},
  {id: 'S7d', title: 'a branch behind main, not brought up to date', expected: 1, reason: BEHIND,
    build: () => built(branchBehindMain(HEADER, HEADER + row(ADA), {[REG]: HEADER + row(BOB)}))},
  {id: 'S7e', title: 'control: the same branch rebased on main, both lines kept', expected: 0,
    build: () => {
      const repo = branchBehindMain(HEADER, HEADER + row(ADA), {[REG]: HEADER + row(BOB)});
      repo.rebaseOnMain(ADA);
      return built(repo);
    }},
  // Accepted behind main since it leaves the register alone, the branch is judged against the
  // register of the current base: the author's line is gone there.
  {id: 'S19', title: 'a branch from before a maintainer removed the author\'s line', expected: 1,
    reason: /- 1003\+eve@users\.noreply\.github\.com \(author, committer\)/,
    build: () => {
      const repo = new Repo(HEADER + row(EVE));
      repo.commit(EVE, {'f': 'code\n'});
      repo.commitOnMain(MAINTAINER, {[REG]: HEADER});
      return built(repo);
    }},
  {id: 'S19r', title: 'the same branch rebased: the author\'s line is gone', expected: 1,
    reason: /- 1003\+eve@users\.noreply\.github\.com \(author, committer\)/,
    build: () => {
      const repo = new Repo(HEADER + row(EVE));
      repo.commit(EVE, {'f': 'code\n'});
      repo.commitOnMain(MAINTAINER, {[REG]: HEADER});
      repo.rebaseOnMain(EVE);
      return built(repo);
    }},
  {id: 'S21', title: 'a commit without a parent, signed by its own line', expected: 1, reason: ROOT_COMMIT,
    build: () => {
      const repo = new Repo(HEADER);
      git(repo.dir, ['checkout', '-q', '--orphan', 'alien']);
      return built(repo, repo.commit(EVE, {[REG]: HEADER + row(EVE), 'alien.txt': 'x\n'}));
    }},
];

export const MALLORY: Person = {name: 'Mallory Example', email: 'mallory@example.com'};

// A branch made from `main`, then `main` moves with `onMain` (by a maintainer unless `holder`).
function behindMain(registerAtBase: string, branch: (repo: Repo) => void, onMain: Record<string, string>,
  holder: Person = MAINTAINER): () => Built {
  return () => {
    const repo = new Repo(registerAtBase);
    branch(repo);
    repo.commitOnMain(holder, onMain);
    return built(repo);
  };
}

// Eve adds a line for Mallory and removes it in the next commit, while main gains Bob's line at the
// same place: the test merge sees no change of Eve's, the replay of her commits keeps Mallory's
// line (tests/cla-check-merge.test.ts shows it). A branch behind main that changes the register is
// therefore refused, whatever its net change.
export function addsThenRemovesMallory(repo: Repo): void {
  repo.commit(EVE, {'f': 'code\n', [REG]: HEADER + row(EVE) + row(MALLORY)});
  repo.commit(EVE, {'g': 'code\n', [REG]: HEADER + row(EVE)});
}

// SPEC.md, "Why a branch behind the base is accepted only when it leaves the register alone".
const BEHIND_BASE: Scenario[] = [
  {id: 'B1', title: 'control: a signatory\'s branch behind main that leaves the register alone', expected: 0,
    build: behindMain(HEADER + row(ADA), (repo) => repo.commit(ADA, {'f': 'code\n'}), {'g': 'main\n', [REG]: HEADER + row(ADA) + row(BOB)}, BOB)},
  {id: 'B2', title: 'behind main, register untouched, an unsigned commit in the range', expected: 1,
    reason: /- 1003\+eve@users\.noreply\.github\.com \(author, committer\)/,
    build: behindMain(HEADER + row(ADA), (repo) => {
      repo.commit(ADA, {'f': 'code\n'});
      repo.commit(EVE, {'f': 'code2\n'});
    }, {'g': 'main\n'})},
  {id: 'B3', title: 'behind main, a commit adds a line and a later one removes it', expected: 1, reason: BEHIND,
    build: behindMain(HEADER + row(EVE), addsThenRemovesMallory, {[REG]: HEADER + row(EVE) + row(BOB)}, BOB)},
  {id: 'B4', title: 'behind main, the author signs in the pull request', expected: 1, reason: BEHIND,
    build: behindMain(HEADER, (repo) => repo.commit(ADA, {'f': 'code\n', [REG]: HEADER + row(ADA)}), {'g': 'main\n'})},
  {id: 'B5', title: 'behind main, a commit changes only the mode of the register', expected: 1, reason: BEHIND,
    build: behindMain(HEADER + row(ADA), (repo) => {
      fs.chmodSync(path.join(repo.dir, REG), 0o755);
      repo.commit(ADA, {'f': 'code\n'});
    }, {'g': 'main\n'})},
  {id: 'B6', title: 'behind main, a merge commit in the range', expected: 1, reason: MERGE_COMMIT,
    build: () => {
      const repo = new Repo(HEADER + row(ADA));
      repo.commit(ADA, {'f': 'code\n'});
      repo.mergeSideBranch(ADA, HEADER + row(ADA));
      repo.commitOnMain(MAINTAINER, {'g': 'main\n'});
      return built(repo);
    }},
  {id: 'B7', title: 'an unsigned commit below the branch point is on main already and not judged', expected: 0,
    build: () => {
      const repo = new Repo(HEADER + row(ADA));
      repo.commitOnMain(EVE, {'e': 'merged earlier\n'});
      repo.restartFromMain();
      repo.commit(ADA, {'f': 'code\n'});
      repo.commitOnMain(MAINTAINER, {'g': 'main\n'});
      return built(repo);
    }},
  {id: 'B8', title: 'a force-pushed branch behind main that dropped its signing commit', expected: 1,
    reason: /- 1001\+ada@users\.noreply\.github\.com \(author, committer\)/,
    build: () => {
      const repo = new Repo(HEADER);
      repo.commit(ADA, {'f': 'code\n', [REG]: HEADER + row(ADA)});
      git(repo.dir, ['reset', '-q', '--hard', repo.base]);
      repo.commit(ADA, {'f': 'code\n'});
      repo.commitOnMain(MAINTAINER, {'g': 'main\n'});
      return built(repo);
    }},
];

// S8: an ordinary commit that drops a third party's line; S8b adds a `parent <root>` header after
// the committer line, which Git does not read as a parent.
function dropsBobsLine(forgeParent: boolean): () => Built {
  return () => {
    const repo = new Repo(HEADER);
    const root = repo.base;
    repo.commitOnMain(BOB, {[REG]: HEADER + row(BOB)});
    repo.commitOnMain(EVE, {[REG]: HEADER + row(BOB) + row(EVE)});
    repo.restartFromMain();
    const plain = repo.commit(EVE, {[REG]: HEADER + row(EVE)});
    if (!forgeParent) return built(repo, plain);
    const stamp = `Eve Example <${EVE.email}> ${STAMP}`;
    return built(repo, repo.forge(`tree ${repo.tree(plain)}\nparent ${repo.base}\nauthor ${stamp}\ncommitter ${stamp}\nparent ${root}\n\nforged\n`));
  };
}

function twoAuthorLines(): Built {
  const repo = new Repo(HEADER + row(ADA));
  repo.commit(EVE, {'feature.txt': 'code\n'});
  const text = `tree ${repo.tree()}\nparent ${repo.base}\nauthor ${who(ADA)} 1 +0000\nauthor ${who(EVE)} ${STAMP}\n` +
    `committer ${who(ADA)} ${STAMP}\n\nforged\n`;
  return built(repo, repo.forge(text));
}

const HEADERS: Scenario[] = [
  {id: 'S8a', title: 'control: a plain commit drops a third party line', expected: 1, build: dropsBobsLine(false)},
  {id: 'S8b', title: 'the same commit with a forged parent header after the committer', expected: 1, build: dropsBobsLine(true)},
  {id: 'S9a', title: 'two addresses in the author header, the signed one last', expected: 2,
    build: forged(`Eve <${EVE.email}> <${ADA.email}>`)},
  {id: 'S9b', title: 'two addresses in the author header, the signed one first', expected: 2,
    build: forged(`Eve <${ADA.email}> <${EVE.email}>`)},
  {id: 'S9c', title: 'a signed address inside the name', expected: 1, build: forged(`${ADA.email} <${EVE.email}>`)},
  {id: 'S9d', title: 'control: the upper case of a signed address', expected: 0,
    build: forged(`Ada <${ADA.email.toUpperCase()}>`, who(ADA))},
  {id: 'S9g', title: 'an empty author address', expected: 1, build: forged('Eve <>')},
  {id: 'S9h', title: 'no author address at all', expected: 2, build: forged('Eve')},
  {id: 'S9i', title: 'two author lines, the signed one first', expected: 2, build: twoAuthorLines},
  {id: 'S9j', title: 'two committer lines', expected: 2,
    build: () => {
      const repo = new Repo(HEADER + row(ADA));
      const line = `${who(ADA)} ${STAMP}`;
      return built(repo, repo.forge(`tree ${repo.tree()}\nparent ${repo.base}\nauthor ${line}\ncommitter ${line}\ncommitter ${who(EVE)} ${STAMP}\n\nforged\n`));
    }},
  {id: 'S10', title: 'a .mailmap that maps the author to a signatory', expected: 1,
    build: simple(HEADER + row(ADA), (repo) => repo.commit(EVE, {'.mailmap': `${who(ADA)} ${who(EVE)}\n`}))},
  {id: 'S12a', title: 'an unsigned author with GitHub as committer', expected: 1,
    build: simple(HEADER + row(ADA), (repo) => repo.commit(EVE, {'f': 'code\n'}, WEB))},
  {id: 'S12c', title: 'the GitHub committer name in lower case', expected: 1,
    build: simple(HEADER + row(ADA), (repo) => repo.commit(ADA, {'f': 'code\n'}, {...WEB, name: 'github'}))},
  {id: 'S15', title: 'addresses made of workflow commands', expected: 1,
    build: simple(HEADER, (repo) => repo.commit({name: '::error file=a::pwn', email: '::add-mask::@x'},
      {'f': 'code\n', [REG]: HEADER + '| x | ::error::@x | 1.0 | 2026-11-20 |\n'}))},
  // Git does not verify addresses: anyone can write a maintainer's. The check cannot see it; the
  // maintainers compare the account that opened the pull request with the addresses it uses.
  {id: 'S16', title: 'known limit: a forged maintainer address', expected: 0,
    build: simple(HEADER + row(BOB), (repo) => repo.commit({...MAINTAINER, name: 'Not Mathias'}, {'f': 'code\n', [REG]: HEADER}))},
];

export const SCENARIOS: Scenario[] = [...REGISTER_CHANGES, ...MERGES, ...BEHIND_BASE, ...HEADERS];
