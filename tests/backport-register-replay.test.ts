// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The two scripts of .github/workflows/backport-register.yml, taken from the committed file and run
// with bash on throwaway repositories, `gh` replaced by a stand-in that records its arguments. The
// branch the push script opens is then judged by tools/cla-check/cla-check.ts with release/latest as
// base, as the `cla` job of the backport pull request would judge it: a new signatory who signs in
// a minor pull request, and a maintainer added by a governance commit, both pass, and the other files
// of the minor pull request stay on main.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {parseLines} from './public-ci-workflow-lib.ts';
import {ADA, CHECKER, EVE, git, GIT_ENV, HEADER, MAINTAINER, MAINTAINERS_FILE, type Person, REGISTER_FILE, removeTempDirs, ROOT, row, tempDir, WEB}
  from './cla-check-lib.ts';

const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'backport-register.yml'), 'utf8');
const CAROL: Person = {name: 'Carol Example', email: '1004+carol@users.noreply.github.com'};
const NEWCOMER: Person = {name: 'Nora Maintainer', email: '1005+nora@users.noreply.github.com'};
const BRANCH = (number: number) => `backport-${number}-cla-register-to-release/latest`;

after(removeTempDirs);

// The `run: |` script of the step with that name, without its YAML indentation.
function script(stepName: string): string {
  const lines = parseLines(WORKFLOW);
  const start = lines.findIndex((line) => line.raw.trim() === `- name: ${stepName}`);
  const run = lines.findIndex((line, index) => index > start && line.key === 'run');
  assert.ok(start >= 0 && run > start, `no step ${stepName}`);
  const body: string[] = [];
  for (let index = run + 1; index < lines.length && lines[index].inBlock; index++) body.push(lines[index].raw.slice(10));
  return body.join('\n');
}

// A stand-in for gh: `api .../files` prints the pages of FAKE_GH_FILES (JSON, as `--paginate` does),
// `api .../commits` prints FAKE_GH_COMMITS (what its `--jq` filter prints), `pr create` prints a URL;
// every call is appended to FAKE_GH_LOG.
function fakeGh(): string {
  const bin = tempDir('fake-gh-');
  fs.writeFileSync(path.join(bin, 'gh'), ['#!/usr/bin/env bash', 'printf \'%s\\n\' "${*//$\'\\n\'/ }" >> "$FAKE_GH_LOG"',
    'case "$1 $3" in',
    '  "api "*/files) [[ -n "${FAKE_GH_FAIL:-}" ]] && exit 1; cat "$FAKE_GH_FILES" ;;',
    '  "api "*/commits) cat "$FAKE_GH_COMMITS" ;;',
    'esac',
    // `api repos/.../commits/<sha> --jq '.files | length'`: 0 for a commit of FAKE_GH_EMPTY, else 1.
    'if [[ "$1" == api && "$2" == */commits/* ]]; then [[ " ${FAKE_GH_EMPTY:-} " == *" ${2##*/} "* ]] && echo 0 || echo 1; fi',
    '[[ "$1 $2" == "pr list" && -n "${FAKE_GH_EXISTING:-}" ]] && echo "$FAKE_GH_EXISTING"',
    '[[ "$1 $2" == "pr create" ]] && echo "https://github.com/owner/repo/pull/99"',
    'exit 0', ''].join('\n'), {mode: 0o755});
  return bin;
}

type Run = {status: number | null; output: string; gh: string[]; outputs: string};

function runScript(stepName: string, cwd: string, env: Record<string, string>): Run {
  const work = tempDir('runner-');
  const log = path.join(work, 'gh.log');
  const outputs = path.join(work, 'outputs');
  fs.writeFileSync(log, '');
  fs.writeFileSync(outputs, '');
  const result = spawnSync('bash', ['-c', script(stepName)], {cwd, encoding: 'utf8', env: {...GIT_ENV, PATH: `${fakeGh()}:${process.env.PATH ?? ''}`,
    GITHUB_REPOSITORY: 'owner/repo', GITHUB_OUTPUT: outputs, RUNNER_TEMP: work, FAKE_GH_LOG: log, GH_TOKEN: 'token', ...env}});
  return {status: result.status, output: `${result.stdout}${result.stderr}`, gh: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean),
    outputs: fs.readFileSync(outputs, 'utf8')};
}

describe('the files job decides which merged pull requests have their register backported', () => {
  // `files` is one page of names, or the pages of entries as the API gives them.
  const decide = (labels: string[], files: string[] | object[][], fail = false): Run => {
    const list = path.join(tempDir('files-'), 'list');
    const pages = files.length > 0 && Array.isArray(files[0]) ? files as object[][] : [(files as string[]).map((filename) => ({filename}))];
    fs.writeFileSync(list, pages.map((page) => JSON.stringify(page)).join(''));
    // The value of `contains(github.event.pull_request.labels.*.name, 'semver: patch')`.
    return runScript('List the files of the merged pull request', ROOT, {NUMBER: '20', PATCH: String(labels.includes('semver: patch')),
      FAKE_GH_FILES: list, ...(fail ? {FAKE_GH_FAIL: '1'} : {})});
  };
  const cases: [string, string[], string[], boolean][] = [
    ['a register file and semver: minor', ['semver: minor'], ['src/feature.ts', 'CLA-SIGNATORIES.md'], true],
    ['a register file and no semver label', [], ['tools/cla-check/MAINTAINERS'], true],
    ['each register file alone', ['semver: minor'], ['.github/CODEOWNERS'], true],
    ['another minor pull request', ['semver: minor'], ['src/feature.ts', 'docs/CLA-SIGNATORIES.md', 'CONTRIBUTORS.md.bak'], false],
    ['a semver: patch pull request (backported whole by backport.yml)', ['semver: patch'], ['CLA-SIGNATORIES.md'], false],
  ];
  for (const [label, labels, files, changed] of cases) {
    test(`${label}: ${changed ? 'backported' : 'not by this workflow'}`, () => {
      const result = decide(labels, files);
      assert.equal(result.status, 0, result.output);
      assert.equal(result.outputs, `changed=${changed}\n`);
      if (labels.includes('semver: patch')) assert.deepEqual(result.gh, [], 'no API call for a patch');
      else assert.deepEqual(result.gh, ['api --paginate repos/owner/repo/pulls/20/files']);
    });
  }

  // Each name is compared whole: a name holding a newline and a register path is not that path.
  test('a file name with a newline is not a register file', () => {
    assert.equal(decide(['semver: minor'], ['src/x\nCLA.md', 'CLA-SIGNATORIES.md\n', 'docs/a\n.github/CODEOWNERS\nb']).outputs, 'changed=false\n');
  });

  test('a rename into or out of a register path counts, on any page', () => {
    assert.equal(decide([], [[{filename: 'src/a.ts'}], [{filename: 'docs/CLA.md', previous_filename: 'CLA.md'}]]).outputs, 'changed=true\n');
    assert.equal(decide([], [[{filename: 'CONTRIBUTORS.md', previous_filename: 'docs/people.md'}]]).outputs, 'changed=true\n');
    assert.equal(decide([], [[{filename: 'src/a.ts'}], [{filename: 'src/b.ts', previous_filename: 'src/a.md'}]]).outputs, 'changed=false\n');
  });

  test('an answer that is not a file list fails the job', () => {
    const result = decide([], [[{filename: 'src/a.ts'}], {message: 'Not Found'} as unknown as object[]]);
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
  });

  test('a list at the 3000 files the API returns at most fails the job with the limit diagnostic', () => {
    const page = (start: number): object[] => Array.from({length: 100}, (_, i) => ({filename: `src/f${start + i}.ts`}));
    const full = decide([], [...Array.from({length: 29}, (_, p) => page(p * 100)), [...page(2900).slice(0, 99), {filename: 'CLA.md'}]]);
    assert.notEqual(full.status, 0);
    assert.match(full.output, /lists 3000 files, the most the API returns/);
    assert.equal(full.outputs, '');
    const below = decide([], [...Array.from({length: 29}, (_, p) => page(p * 100)), [...page(2900).slice(0, 98), {filename: 'CLA.md'}]]);
    assert.equal(below.status, 0, below.output);
    assert.equal(below.outputs, 'changed=true\n');
  });

  test('every register file counts', () => {
    for (const file of ['CONTRIBUTORS.md', 'CLA.md', 'CLA-SIGNATORIES.md', 'tools/cla-check/MAINTAINERS', '.github/CODEOWNERS']) {
      assert.equal(decide(['semver: minor'], [file]).outputs, 'changed=true\n', file);
    }
  });

  test('a failing API fails the job instead of answering no', () => {
    const result = decide(['semver: minor'], ['CLA-SIGNATORIES.md'], true);
    assert.notEqual(result.status, 0);
    assert.equal(result.outputs, '');
  });
});

const MAINTAINERS_AT_CUT = `# Maintainers\n${MAINTAINER.name} <${MAINTAINER.email}>\n`;
const CONTRIBUTORS_AT_CUT = '# Contributors\n\n## Maintainers\n\n- Mathias Bourgoin\n';
const CODEOWNERS_AT_CUT = '* @mathiasbourgoin\n';

type Content = string | null | {link: string};
// The landed commit id, the number of commits of the pull request, its commits as the API lists them, and
// those of them that are empty (a rebase merge drops them), and the tip that refs/pull/<number>/head holds
// (the last listed commit unless given; null: no such ref).
type Merged = {landed: string; count: number; listed: string[]; empty?: string[]; head?: string | null};
let clock = 1_800_000_000;

// origin (bare) with main and release/latest, cut together; then main moves on.
class Remote {
  readonly origin = path.join(tempDir('register-origin-'), 'origin.git');
  readonly work = tempDir('register-work-');

  constructor() {
    git(path.dirname(this.origin), ['init', '-q', '--bare', '-b', 'main', this.origin]);
    git(this.work, ['init', '-q', '-b', 'main']);
    git(this.work, ['remote', 'add', 'origin', this.origin]);
    this.commit(MAINTAINER, MAINTAINER, {'README.md': 'session-mesh\n', [REGISTER_FILE]: HEADER + row(ADA),
      '.gitattributes': fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'), [MAINTAINERS_FILE]: MAINTAINERS_AT_CUT,
      'CONTRIBUTORS.md': CONTRIBUTORS_AT_CUT, '.github/CODEOWNERS': CODEOWNERS_AT_CUT, 'CLA.md': 'CLA 1.0\n'});
    git(this.work, ['push', '-q', 'origin', 'main', 'main:release/latest']);
    this.commit(MAINTAINER, MAINTAINER, {'src/after-cut.ts': 'export {};\n'});
    git(this.work, ['push', '-q', 'origin', 'main']);
  }

  // A file's content, or null to delete it, or {link} for a symbolic link. Each commit gets its own
  // author date, in a time zone other than UTC.
  commit(author: Person, committer: Person, files: Record<string, Content>): string {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(this.work, name);
      fs.rmSync(file, {force: true, recursive: true});
      if (content === null) continue;
      fs.mkdirSync(path.dirname(file), {recursive: true});
      if (typeof content === 'string') fs.writeFileSync(file, content);
      else fs.symlinkSync(content.link, file);
    }
    git(this.work, ['add', '-A']);
    git(this.work, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `change by ${author.name}`], {GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: `@${clock++} +0200`, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.email});
    return git(this.work, ['rev-parse', 'HEAD']);
  }

  // How the API lists a commit of the pull request: its author's address and author date, in UTC.
  listed(commit: string): string {
    const [email, seconds] = git(this.work, ['show', '-s', '--format=%ae%n%at', commit]).split('\n');
    return `${commit} ${email} ${new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z')}`;
  }

  read(file: string): string {
    return fs.readFileSync(path.join(this.work, file), 'utf8');
  }

  // A pull request merged by "Rebase and merge": its commits land on main, committed by a maintainer.
  // A commit of `emptyAt` is empty: it is listed by the API but not landed, as a rebase merge drops it.
  merge(commits: [Person, Record<string, Content>][], emptyAt: number[] = []): Merged {
    git(this.work, ['checkout', '-q', 'main']);
    const listed: string[] = [];
    const empty: string[] = [];
    let landed = '';
    commits.forEach(([author, files], index) => {
      const commit = this.commit(author, MAINTAINER, emptyAt.includes(index) ? {} : files);
      listed.push(this.listed(commit));
      if (!emptyAt.includes(index)) { landed = commit; return; }
      empty.push(commit);
      git(this.work, ['reset', '-q', '--hard', 'HEAD~1']);
    });
    git(this.work, ['push', '-q', 'origin', 'main']);
    return {landed, count: commits.length, listed, empty};
  }

  // The job: a full clone of origin on main, then the push script. `gh` keeps the calls other than
  // the read of the pull request's commits, which `api` holds.
  backport(number: number, merged: Merged, hasAppToken = 'true', extra: Record<string, string> = {}): Run & {api: string[]} {
    const clone = path.join(tempDir('register-clone-'), 'repo');
    git(path.dirname(clone), ['clone', '-q', this.origin, clone]);
    const tip = merged.head === undefined ? merged.listed.at(-1)?.split(' ')[0] : merged.head;
    if (tip && git(this.work, ['rev-parse', '--verify', '-q', `${tip}^{commit}`], {}, true)) {
      git(this.work, ['push', '-q', '--force', 'origin', `${tip}:refs/pull/${number}/head`]);
    }
    const commits = path.join(tempDir('commits-'), 'list');
    fs.writeFileSync(commits, merged.listed.map((line) => `${line}\n`).join(''));
    const run = runScript('Open the pull request of the register changes', clone, {NUMBER: String(number), LANDED: merged.landed,
      COUNT: String(merged.count), HAS_APP_TOKEN: hasAppToken, FAKE_GH_COMMITS: commits, FAKE_GH_EMPTY: (merged.empty ?? []).join(' '), ...extra});
    return {...run, gh: run.gh.filter((call) => !call.startsWith('api ')), api: run.gh.filter((call) => call.startsWith('api '))};
  }

  ref(name: string): string {
    return git(this.origin, ['rev-parse', '--verify', '-q', name], {}, true);
  }

  // The verdict of the cla check on `head` as a pull request to release/latest.
  cla(head: string): number | null {
    const base = this.ref('release/latest');
    const merge = git(this.origin, ['commit-tree', '-p', base, '-p', head, '-m', 'test merge', `${head}^{tree}`],
      {GIT_AUTHOR_NAME: WEB.name, GIT_AUTHOR_EMAIL: WEB.email, GIT_COMMITTER_NAME: WEB.name, GIT_COMMITTER_EMAIL: WEB.email});
    return spawnSync(process.execPath, ['--experimental-strip-types', CHECKER, '--base', base, '--head', head, '--merge', merge, '--repo', this.origin],
      {encoding: 'utf8', env: GIT_ENV}).status;
  }

  // "Rebase and merge" of the backport pull request, which here is a fast-forward of release/latest.
  integrate(number: number): void {
    git(this.origin, ['update-ref', 'refs/heads/release/latest', this.ref(BRANCH(number))]);
  }

  // Files changed on release/latest alone, as its owner or a maintainer would change them there.
  releaseOnly(files: Record<string, Content>): void {
    git(this.work, ['fetch', '-q', 'origin']);
    git(this.work, ['checkout', '-q', '-B', 'release-work', 'origin/release/latest']);
    this.commit(MAINTAINER, MAINTAINER, files);
    git(this.work, ['push', '-q', 'origin', 'release-work:release/latest']);
    git(this.work, ['checkout', '-q', 'main']);
  }

  // A commit of `author` on top of release/latest, as a later backport would bring it.
  commitOnRelease(author: Person): string {
    git(this.work, ['fetch', '-q', 'origin']);
    git(this.work, ['checkout', '-q', '-B', 'release-work', 'origin/release/latest']);
    const commit = this.commit(author, WEB, {'src/fix.ts': `fix by ${author.name}\n`});
    git(this.work, ['push', '-q', 'origin', `${commit}:refs/heads/release-work-${commit.slice(0, 12)}`]);
    git(this.work, ['checkout', '-q', 'main']);
    return commit;
  }
}

const header = (repo: string, commit: string, field: 'author' | 'committer'): string =>
  git(repo, ['cat-file', 'commit', commit]).split('\n').find((line) => line.startsWith(`${field} `))?.replace(/ \d+ [+-]\d{4}$/, '') ?? '';

describe('the push job replays the register changes onto release/latest', () => {
  test('a governance commit adding a maintainer: register-only branch, cla passes, the new maintainer then passes too', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {[MAINTAINERS_FILE]: `${MAINTAINERS_AT_CUT}${NEWCOMER.name} <${NEWCOMER.email}>\n`,
      'CONTRIBUTORS.md': `${CONTRIBUTORS_AT_CUT}- Nora Maintainer\n`, '.github/CODEOWNERS': '* @mathiasbourgoin @nora\n'}]]);
    const before = remote.commitOnRelease(NEWCOMER);
    assert.equal(remote.cla(before), 1, 'before the register backport, the new maintainer is refused on release/latest');

    const result = remote.backport(10, merged);
    assert.equal(result.status, 0, result.output);
    const head = remote.ref(BRANCH(10));
    assert.ok(head, 'the backport branch is pushed');
    assert.deepEqual(git(remote.origin, ['diff', '--name-only', 'release/latest', head]).split('\n').sort(),
      ['.github/CODEOWNERS', 'CONTRIBUTORS.md', MAINTAINERS_FILE]);
    assert.equal(header(remote.origin, head, 'author'), `author ${MAINTAINER.name} <${MAINTAINER.email}>`);
    assert.equal(header(remote.origin, head, 'committer'), 'committer GitHub <noreply@github.com>');
    assert.equal(remote.cla(head), 0);
    assert.equal(result.api.length, 1);
    assert.ok(result.api[0].startsWith('api --paginate repos/owner/repo/pulls/10/commits --jq '), result.api[0]);
    assert.equal(result.gh.length, 1, 'with the App token, no comment asking to start the CI');
    assert.ok(result.gh[0].startsWith(`pr create --repo owner/repo --base release/latest --head ${BRANCH(10)} --label semver: patch ` +
      '--title [release/latest] CLA register changes of #10 --body Backport of #10 to `release/latest`, restricted to the CLA register files'), result.gh[0]);

    remote.integrate(10);
    assert.equal(remote.cla(remote.commitOnRelease(NEWCOMER)), 0, 'after it, the new maintainer passes on release/latest');
  });

  test('a new signatory in a minor pull request with other files: only the register line goes, under their authorship, cla passes', () => {
    const remote = new Remote();
    const merged = remote.merge([
      [CAROL, {'src/feature.ts': 'export const feature = 1;\n', [REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(CAROL)}`}],
      [CAROL, {'src/feature.ts': 'export const feature = 2;\n'}],
    ]);
    const result = remote.backport(11, merged, 'false');
    assert.equal(result.status, 0, result.output);
    const head = remote.ref(BRANCH(11));
    assert.equal(git(remote.origin, ['rev-list', '--count', `release/latest..${head}`]), '1', 'the commit without register change is left out');
    assert.deepEqual(git(remote.origin, ['diff', '--name-only', 'release/latest', head]).split('\n'), [REGISTER_FILE]);
    assert.equal(git(remote.origin, ['ls-tree', '--name-only', head, 'src/']), '', 'the feature stays on main');
    assert.ok(git(remote.origin, ['show', `${head}:${REGISTER_FILE}`]).includes(row(CAROL).trim()));
    assert.equal(header(remote.origin, head, 'author'), `author ${CAROL.name} <${CAROL.email}>`);
    assert.equal(header(remote.origin, head, 'committer'), 'committer GitHub <noreply@github.com>');
    assert.equal(git(remote.origin, ['log', '-1', '--format=%s', head]), `change by ${CAROL.name}`);
    assert.equal(remote.cla(head), 0);
    assert.match(result.gh[1] ?? '', /^pr comment https:\/\/github\.com\/owner\/repo\/pull\/99 --repo owner\/repo --body This pull request was opened with the run's own token/);
    assert.match(result.gh[1], /A maintainer with write access starts it with 'Approve workflows to run' on this pull request; closing and reopening it is not needed\.$/);
    assert.doesNotMatch(result.gh[1], /reopen the|by closing and reopening/);
  });

  test('a minor pull request whose commits change no register file: nothing is pushed or opened', () => {
    const remote = new Remote();
    const result = remote.backport(12, remote.merge([[ADA, {'src/other.ts': 'export {};\n'}]]));
    assert.equal(result.status, 0, result.output);
    assert.equal(remote.ref(BRANCH(12)), '');
    assert.deepEqual(result.gh, []);
  });

  // A rebase merge drops a commit without any change: COUNT then exceeds the landed commits, and an
  // offset of COUNT from the merge commit would reach a commit already on main.
  test('an empty commit at the head or the start of the pull request does not skew the landed range', () => {
    for (const [emptyAt, label] of [[[1], 'head'], [[0], 'start'], [[0, 2], 'both ends']] as [number[], string][]) {
      const remote = new Remote();
      const signed = {[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(CAROL)}`};
      const commits: [Person, Record<string, Content>][] = emptyAt.length === 2 ? [[CAROL, {}], [CAROL, signed], [CAROL, {}]]
        : [[CAROL, emptyAt[0] === 0 ? {} : signed], [CAROL, emptyAt[0] === 0 ? signed : {}]];
      const merged = remote.merge(commits, emptyAt);
      assert.equal(merged.count - (merged.empty?.length ?? 0), 1, label);
      const result = remote.backport(40, merged);
      assert.equal(result.status, 0, `${label}: ${result.output}`);
      const head = remote.ref(BRANCH(40));
      assert.equal(git(remote.origin, ['rev-list', '--count', `release/latest..${head}`]), '1', label);
      assert.deepEqual(git(remote.origin, ['diff', '--name-only', 'release/latest', head]).split('\n'), [REGISTER_FILE], label);
      assert.equal(remote.cla(head), 0, label);
    }
  });

  test('a commit with no landed commit that is not empty is refused, and the commit before the pull request is never taken', () => {
    const remote = new Remote();
    const merged = remote.merge([[CAROL, {[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(CAROL)}`}], [CAROL, {'notes.txt': 'x\n'}]]);
    // The API lists a third commit that landed nowhere and is not empty: not a rebase merge.
    const stray = `${'a'.repeat(40)} ${CAROL.email} 2026-01-01T00:00:00Z`;
    const result = remote.backport(41, {...merged, count: 3, listed: [stray, ...merged.listed]});
    assert.notEqual(result.status, 0);
    assert.match(result.output, /the landed commits are not those of the pull request as a rebase merge lands them/);
    assert.equal(remote.ref(BRANCH(41)), '');
    assert.deepEqual(result.gh, []);
  });

  // What the exact comparison refuses: the run fails closed with one comment on the original pull request,
  // pushes nothing and leaves release/latest as it is. A patch that does not apply is refused the same way,
  // with its own comment.
  const refusal = /^pr comment (\d+) --repo owner\/repo --body (Replaying the commits of this pull request does not give this register file|This register file on release\/latest is not what main held|The changes of this pull request to the CLA register files do not apply)/;
  const diverges = (result: Run & {api: string[]}, remote: Remote, number: number, before: string, message = /the replay does not give .* as it is on main; nothing is pushed/): void => {
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, message);
    assert.equal(remote.ref(BRANCH(number)), '');
    assert.equal(remote.ref('release/latest'), before);
    assert.equal(result.gh.length, 1);
    assert.match(result.gh[0], refusal);
    assert.equal(result.gh[0].match(refusal)?.[1], String(number));
  };
  const compared = /the replay does not give .* as it is on main; nothing is pushed/;
  const releaseFile = (remote: Remote, file: string): string => git(remote.origin, ['show', `release/latest:${file}`]);
  const nora = `${NEWCOMER.name} <${NEWCOMER.email}>\n`;
  // main lists Nora; release/latest revoked her there alone.
  const revokedOnRelease = (): {remote: Remote; before: string; listed: string} => {
    const remote = new Remote();
    const listed = `${MAINTAINERS_AT_CUT}${nora}`;
    remote.commit(MAINTAINER, MAINTAINER, {[MAINTAINERS_FILE]: listed});
    git(remote.work, ['push', '-q', 'origin', 'main']);
    remote.releaseOnly({[MAINTAINERS_FILE]: listed});
    remote.releaseOnly({[MAINTAINERS_FILE]: MAINTAINERS_AT_CUT});
    return {remote, before: remote.ref('release/latest'), listed};
  };

  test('a register file that release/latest alone changed: refused with a comment, nothing pushed', () => {
    const remote = new Remote();
    remote.releaseOnly({'CONTRIBUTORS.md': CONTRIBUTORS_AT_CUT.replace('# Contributors', '# Contributors of release/latest')});
    const before = remote.ref('release/latest');
    diverges(remote.backport(42, remote.merge([[ADA, {'CONTRIBUTORS.md': `${CONTRIBUTORS_AT_CUT}- Ada Example\n`}]])), remote, 42, before, compared);
  });

  // A signatory line added on release/latest by its owner is not on main: a maintainer's pull request that
  // touches the register must not leave it there as a difference nobody judged.
  test('a signatory line only release/latest holds: refused, the line is still there', () => {
    const remote = new Remote();
    remote.releaseOnly({[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(EVE)}`});
    const before = remote.ref('release/latest');
    const merged = remote.merge([[MAINTAINER, {[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(CAROL)}`}]]);
    diverges(remote.backport(43, merged), remote, 43, before, compared);
    assert.ok(releaseFile(remote, REGISTER_FILE).includes(row(EVE).trim()), 'the line is still there');
  });

  test('a revocation made on release/latest alone, then a pull request that adds a line: refused, the revocation stands', () => {
    const {remote, before, listed} = revokedOnRelease();
    const merged = remote.merge([[MAINTAINER, {[MAINTAINERS_FILE]: `${listed}${CAROL.name} <${CAROL.email}>\n`}]]);
    diverges(remote.backport(44, merged), remote, 44, before);
    assert.ok(!releaseFile(remote, MAINTAINERS_FILE).includes(NEWCOMER.email), 'the revocation stands');
  });

  // Probe A: +Eve, -Eve, +Carol over a release/latest that holds Eve alone. The net change of the range is +Carol.
  test('commits that add a release-only signatory line, remove it and add another: refused, the line stays', () => {
    const remote = new Remote();
    const base = remote.read(REGISTER_FILE);
    remote.releaseOnly({[REGISTER_FILE]: `${base}${row(EVE)}`});
    const before = remote.ref('release/latest');
    const merged = remote.merge([[MAINTAINER, {[REGISTER_FILE]: `${base}${row(EVE)}`}], [MAINTAINER, {[REGISTER_FILE]: base}],
      [MAINTAINER, {[REGISTER_FILE]: `${base}${row(CAROL)}`}]]);
    diverges(remote.backport(46, merged), remote, 46, before);
    assert.ok(releaseFile(remote, REGISTER_FILE).includes(row(EVE).trim()), 'the line is still there');
  });

  // Probe B: -Nora, then +Nora and +Carol, over a release/latest that revoked Nora alone.
  test('commits that remove a maintainer revoked on release/latest alone and add her back with another: refused, the revocation stands', () => {
    const {remote, before, listed} = revokedOnRelease();
    const merged = remote.merge([[MAINTAINER, {[MAINTAINERS_FILE]: MAINTAINERS_AT_CUT}],
      [MAINTAINER, {[MAINTAINERS_FILE]: `${listed}${CAROL.name} <${CAROL.email}>\n`}]]);
    diverges(remote.backport(47, merged), remote, 47, before);
    assert.ok(!releaseFile(remote, MAINTAINERS_FILE).includes(NEWCOMER.email), 'the revocation stands');
  });

  // A pull request that merely moves Nora has the net change -Nora/+Nora with +Carol; and the two-commit variant.
  test('a pull request that moves a maintainer revoked on release/latest alone, with a new one: refused, one commit or two', () => {
    for (const [commits, label] of [[1, 'one commit'], [2, 'two commits']] as [number, string][]) {
      const {remote, before} = revokedOnRelease();
      const dave = `Dave Example <1006+dave@users.noreply.github.com>\n`;
      remote.commit(MAINTAINER, MAINTAINER, {[MAINTAINERS_FILE]: `${MAINTAINERS_AT_CUT}${nora}${dave}`});
      git(remote.work, ['push', '-q', 'origin', 'main']);
      const carol = `${CAROL.name} <${CAROL.email}>\n`;
      const moved = `${MAINTAINERS_AT_CUT}${dave}${nora}${carol}`;
      const steps: [Person, Record<string, Content>][] = commits === 1 ? [[MAINTAINER, {[MAINTAINERS_FILE]: moved}]]
        : [[MAINTAINER, {[MAINTAINERS_FILE]: `${MAINTAINERS_AT_CUT}${dave}`}], [MAINTAINER, {[MAINTAINERS_FILE]: moved}]];
      diverges(remote.backport(48, remote.merge(steps)), remote, 48, before);
      assert.ok(!releaseFile(remote, MAINTAINERS_FILE).includes(NEWCOMER.email), `${label}: the revocation stands`);
    }
  });

  // A line duplicated on release/latest alone is a difference that a set of lines does not see.
  test('a duplicated line on release/latest alone: refused', () => {
    const remote = new Remote();
    const base = remote.read(REGISTER_FILE);
    remote.releaseOnly({[REGISTER_FILE]: `${base}${row(EVE)}${row(EVE)}`});
    const before = remote.ref('release/latest');
    diverges(remote.backport(49, remote.merge([[MAINTAINER, {[REGISTER_FILE]: `${base}${row(EVE)}`}]])), remote, 49, before, compared);
  });

  // An entry that a later pull request adds on main is not part of the range of this one.
  test('an entry added later on main only: the backport of an earlier pull request is refused', () => {
    const remote = new Remote();
    const before = remote.ref('release/latest');
    const first = remote.merge([[CAROL, {[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(CAROL)}`}]]);
    remote.merge([[EVE, {[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(EVE)}`}]]);
    diverges(remote.backport(45, first), remote, 45, before, compared);
  });

  // The comparison is per touched file: a release-only change in a register file that the range does not
  // touch is kept, and the range is backported.
  test('a release-only change in a register file that the pull request does not touch is kept', () => {
    const remote = new Remote();
    remote.releaseOnly({[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(EVE)}`});
    const result = remote.backport(46, remote.merge([[ADA, {'CONTRIBUTORS.md': `${CONTRIBUTORS_AT_CUT}- Ada Example\n`}]]));
    assert.equal(result.status, 0, result.output);
    const head = remote.ref(BRANCH(46));
    assert.deepEqual(git(remote.origin, ['diff', '--name-only', 'release/latest', head]).split('\n'), ['CONTRIBUTORS.md']);
    assert.ok(git(remote.origin, ['show', `${head}:${REGISTER_FILE}`]).includes(row(EVE).trim()));
  });

  // The positive case: a clean range whose replay gives main's files opens the pull request, blob for blob.
  test('a clean range whose replay equals main opens the pull request, the touched files identical to main', () => {
    const remote = new Remote();
    const merged = remote.merge([[CAROL, {[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(CAROL)}`}],
      [MAINTAINER, {[MAINTAINERS_FILE]: `${MAINTAINERS_AT_CUT}${nora}`}]]);
    const result = remote.backport(60, merged);
    assert.equal(result.status, 0, result.output);
    const head = remote.ref(BRANCH(60));
    for (const file of [REGISTER_FILE, MAINTAINERS_FILE]) {
      assert.equal(git(remote.origin, ['rev-parse', `${head}:${file}`]), git(remote.origin, ['rev-parse', `main:${file}`]), file);
    }
    assert.equal(result.gh.filter((call) => call.startsWith('pr create')).length, 1);
  });

  // A removal whose line was added by a pull request not yet backported: whichever of the two is backported
  // first, release/latest does not hold the file as main held it before the range (removal), or the replay
  // brings a line that main no longer has (addition). The workflow does not repair it: both are refused, with
  // the manual path in the comment.
  test('a removal replayed before the addition it depends on: both are refused with the manual path, in either order', () => {
    for (const order of [['addition', 'removal'], ['removal', 'addition']]) {
      const remote = new Remote();
      const register = remote.read(REGISTER_FILE);
      const addition = remote.merge([[CAROL, {[REGISTER_FILE]: `${register}${row(CAROL)}`}]]);
      const removal = remote.merge([[MAINTAINER, {[REGISTER_FILE]: register}]]);
      const before = remote.ref('release/latest');
      assert.equal(remote.read(REGISTER_FILE), register, 'main ends without the line');
      for (const [position, step] of order.entries()) {
        const number = 50 + position;
        const result = remote.backport(number, step === 'addition' ? addition : removal);
        diverges(result, remote, number, before);
        assert.match(result.gh[0], /A maintainer backports the register changes of this pull request by hand.*docs\/development\.md/);
      }
      assert.equal(remote.ref('release/latest'), before);
    }
  });

  // release/latest worded CLA.md differently: the replay cannot give main's file; a patch that does not apply
  // gets its own comment.
  test('a register change on a file that release/latest worded differently: nothing is pushed, the original pull request gets a comment, the job fails', () => {
    const remote = new Remote();
    git(remote.work, ['checkout', '-q', '-B', 'release-work', 'origin/release/latest']);
    remote.commit(MAINTAINER, MAINTAINER, {'CLA.md': 'CLA 1.0, release wording\n'});
    git(remote.work, ['push', '-q', 'origin', 'release-work:release/latest']);
    git(remote.work, ['checkout', '-q', 'main']);
    const result = remote.backport(13, remote.merge([[MAINTAINER, {'CLA.md': 'CLA 1.0, main wording\n'}]]));
    assert.notEqual(result.status, 0);
    assert.equal(remote.ref(BRANCH(13)), '');
    assert.equal(result.gh.length, 1);
    assert.match(result.gh[0], /^pr comment 13 --repo owner\/repo --body (Replaying the commits of this pull request does not give this register file|This register file on release\/latest is not what main held|The changes of this pull request to the CLA register files do not apply)/);
  });

  // Author and author date can be forged on a commit of the pull request; the landed commit must carry its change.
  test('a landed commit whose author and date match but whose change is not that of the pull request commit is refused', () => {
    const remote = new Remote();
    const merged = remote.merge([[CAROL, {[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(CAROL)}`}]]);
    const [name, email, seconds] = git(remote.work, ['show', '-s', '--format=%an%n%ae%n%at', merged.landed]).split('\n');
    const forged = git(remote.work, ['commit-tree', `${merged.landed}~1^{tree}`, '-p', `${merged.landed}~1`, '-m', 'forged'],
      {GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: `@${seconds} +0200`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email});
    const result = remote.backport(47, {...merged, listed: [remote.listed(forged)], head: forged});
    assert.notEqual(result.status, 0);
    assert.match(result.output, /a landed commit does not carry the change of its commit of the pull request/);
    assert.equal(remote.ref(BRANCH(47)), '');
    assert.deepEqual(result.gh, []);
  });

  test('a commit of the pull request that this repository does not hold fails closed', () => {
    const remote = new Remote();
    const merged = remote.merge([[CAROL, {[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(CAROL)}`}]]);
    const [name, email, seconds] = git(remote.work, ['show', '-s', '--format=%an%n%ae%n%at', merged.landed]).split('\n');
    const absent = git(remote.work, ['commit-tree', `${merged.landed}~1^{tree}`, '-p', `${merged.landed}~1`, '-m', 'absent'],
      {GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: `@${seconds} +0200`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email});
    const result = remote.backport(48, {...merged, listed: [remote.listed(absent)], head: null});
    assert.notEqual(result.status, 0);
    assert.match(result.output, /a commit of the pull request cannot be fetched; nothing is pushed/);
    assert.equal(remote.ref(BRANCH(48)), '');
    assert.deepEqual(result.gh, []);
  });

  // A first run pushed the branch and failed before the pull request was opened; the rerun rebuilds the
  // commits (another committer date, so other ids), finds the branch, and reuses it instead of pushing.
  test('a rerun after a push whose pull request was not opened reuses the branch and opens the pull request', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {[MAINTAINERS_FILE]: `${MAINTAINERS_AT_CUT}${NEWCOMER.name} <${NEWCOMER.email}>\n`}]]);
    assert.equal(remote.backport(16, merged, 'true', {GIT_COMMITTER_DATE: '@1700000000 +0000'}).status, 0);
    const pushed = remote.ref(BRANCH(16));
    const rerun = remote.backport(16, merged, 'true', {GIT_COMMITTER_DATE: '@1700009999 +0000'});
    assert.equal(rerun.status, 0, rerun.output);
    assert.match(rerun.output, /is this replay; reusing it/);
    assert.equal(remote.ref(BRANCH(16)), pushed, 'the pushed branch is untouched, not force-pushed');
    assert.deepEqual(rerun.gh.map((call) => call.split(' ').slice(0, 2).join(' ')), ['pr list', 'pr create']);
  });

  test('a rerun finds the pull request already open and does nothing more', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {[MAINTAINERS_FILE]: `${MAINTAINERS_AT_CUT}${NEWCOMER.name} <${NEWCOMER.email}>\n`}]]);
    assert.equal(remote.backport(17, merged).status, 0);
    // What the `--jq` filter of `gh pr list` prints: url, state and whether the label is there, tab separated.
    const rerun = remote.backport(17, merged, 'true', {GIT_COMMITTER_DATE: '@1700009999 +0000', FAKE_GH_EXISTING: 'https://github.com/owner/repo/pull/99\tOPEN\ttrue'});
    assert.equal(rerun.status, 0, rerun.output);
    assert.deepEqual(rerun.gh.map((call) => call.split(' ').slice(0, 2).join(' ')), ['pr list']);
    assert.match(rerun.gh[0], / --base release\/latest /, 'only a pull request to release/latest counts');
  });

  test('a rerun that finds the open pull request without its label restores it', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {[MAINTAINERS_FILE]: `${MAINTAINERS_AT_CUT}${NEWCOMER.name} <${NEWCOMER.email}>\n`}]]);
    assert.equal(remote.backport(21, merged).status, 0);
    const rerun = remote.backport(21, merged, 'true', {GIT_COMMITTER_DATE: '@1700009999 +0000', FAKE_GH_EXISTING: 'https://github.com/owner/repo/pull/99\tOPEN\tfalse'});
    assert.equal(rerun.status, 0, rerun.output);
    assert.deepEqual(rerun.gh.map((call) => call.split(' ').slice(0, 2).join(' ')), ['pr list', 'pr edit']);
    assert.equal(rerun.gh[1], 'pr edit https://github.com/owner/repo/pull/99 --repo owner/repo --add-label semver: patch');
  });

  test('a rerun that finds a closed pull request without its label leaves it alone', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {[MAINTAINERS_FILE]: `${MAINTAINERS_AT_CUT}${NEWCOMER.name} <${NEWCOMER.email}>\n`}]]);
    assert.equal(remote.backport(22, merged).status, 0);
    const rerun = remote.backport(22, merged, 'true', {GIT_COMMITTER_DATE: '@1700009999 +0000', FAKE_GH_EXISTING: 'https://github.com/owner/repo/pull/99\tCLOSED\tfalse'});
    assert.equal(rerun.status, 0, rerun.output);
    assert.deepEqual(rerun.gh.map((call) => call.split(' ').slice(0, 2).join(' ')), ['pr list']);
  });

  test('a branch of that name that holds something else is reported and left as it is, never force-pushed', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {[MAINTAINERS_FILE]: `${MAINTAINERS_AT_CUT}${NEWCOMER.name} <${NEWCOMER.email}>\n`}]]);
    assert.equal(remote.backport(18, merged).status, 0);
    // A maintainer's own commit on the backport branch.
    git(remote.work, ['fetch', '-q', 'origin', BRANCH(18)]);
    git(remote.work, ['checkout', '-q', '-B', 'maintainer-work', 'FETCH_HEAD']);
    const extra = remote.commit(MAINTAINER, MAINTAINER, {'CONTRIBUTORS.md': `${CONTRIBUTORS_AT_CUT}- Edited by hand\n`});
    git(remote.work, ['push', '-q', 'origin', `${extra}:refs/heads/${BRANCH(18)}`]);
    git(remote.work, ['checkout', '-q', 'main']);
    const rerun = remote.backport(18, merged, 'true', {GIT_COMMITTER_DATE: '@1700009999 +0000'});
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.output, /exists and is not this replay; it is left as it is/);
    assert.equal(remote.ref(BRANCH(18)), extra);
    assert.deepEqual(rerun.gh, []);
  });

  // Same final tree, same authors, author dates and subjects, on the current release/latest: only the tree
  // of the first commit differs (it already holds the final content, which check_register_paths never saw
  // on this branch). The rerun must refuse it and leave it as it is.
  test('a branch with the same final tree but another intermediate tree is refused and left as it is', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {'CONTRIBUTORS.md': `${CONTRIBUTORS_AT_CUT}- First\n`}],
      [CAROL, {[MAINTAINERS_FILE]: `${MAINTAINERS_AT_CUT}${NEWCOMER.name} <${NEWCOMER.email}>\n`}]]);
    assert.equal(remote.backport(19, merged, 'true', {GIT_COMMITTER_DATE: '@1700000000 +0000'}).status, 0);
    git(remote.work, ['fetch', '-q', 'origin', BRANCH(19), 'release/latest']);
    const replayed = git(remote.work, ['rev-list', '--reverse', 'origin/release/latest..FETCH_HEAD']).split('\n');
    assert.equal(replayed.length, 2);
    const finalTree = git(remote.work, ['rev-parse', `${replayed[1]}^{tree}`]);
    let parent = git(remote.work, ['rev-parse', 'origin/release/latest']);
    for (const original of replayed) {
      const [name, email, date, message] = git(remote.work, ['show', '-s', '--format=%an%n%ae%n@%at +0200%n%B', original]).split('\n');
      parent = git(remote.work, ['commit-tree', finalTree, '-p', parent, '-m', message],
        {GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com'});
    }
    git(remote.work, ['push', '-q', '--force', 'origin', `${parent}:refs/heads/${BRANCH(19)}`]);
    const rerun = remote.backport(19, merged, 'true', {GIT_COMMITTER_DATE: '@1700009999 +0000'});
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.output, /exists and is not this replay; it is left as it is/);
    assert.equal(remote.ref(BRANCH(19)), parent);
    assert.deepEqual(rerun.gh, []);
  });

  test('commits that are not on main are refused', () => {
    const remote = new Remote();
    const stray = remote.commitOnRelease(CAROL);
    const result = remote.backport(14, {landed: stray, count: 1, listed: [remote.listed(stray)]});
    assert.notEqual(result.status, 0);
    assert.match(result.output, /the merged commits are not on main/);
    assert.deepEqual([...result.gh, ...result.api], []);
  });

  test('event values of an unexpected shape are refused before any git command', () => {
    const remote = new Remote();
    for (const [landed, count] of [['HEAD', 1], ['a'.repeat(40), 0], ['a'.repeat(40), 251]] as [string, number][]) {
      const result = remote.backport(15, {landed, count, listed: []});
      assert.notEqual(result.status, 0);
      assert.match(result.output, count === 251 ? /more commits than the API lists/ : /unexpected event values/);
    }
  });
});

// What the script refuses or how it treats a register path that is not a plain file change. A refusal
// pushes nothing, opens nothing and fails the job.
describe('the push job replays register paths exactly', () => {
  const refused = (result: Run & {api: string[]}, remote: Remote, number: number, message: RegExp): void => {
    assert.notEqual(result.status, 0);
    assert.match(result.output, message);
    assert.equal(remote.ref(BRANCH(number)), '');
    assert.deepEqual(result.gh, []);
  };

  test('a directory named like a register file: its content is not backported', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {'CLA.md': null, 'CLA.md/run.sh': '#!/bin/sh\necho owned\n'}]]);
    refused(remote.backport(30, merged), remote, 30, /the replay changes a path other than the register files/);
  });

  // The final tree alone would look fine: CLA.md is a file again after the second commit.
  test('a directory named like a register file in an intermediate commit is refused although a later commit restores the file', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {'CLA.md': null, 'CLA.md/run.sh': '#!/bin/sh\necho owned\n'}],
      [MAINTAINER, {'CLA.md/run.sh': null, 'CLA.md': 'CLA 1.0\n'}]]);
    refused(remote.backport(36, merged), remote, 36, /the replay changes a path other than the register files/);
  });

  test('a register path that becomes a symbolic link in an intermediate commit is refused although a later commit restores the file', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {[REGISTER_FILE]: {link: 'CLA.md'}}], [MAINTAINER, {[REGISTER_FILE]: HEADER + row(ADA)}]]);
    refused(remote.backport(37, merged), remote, 37, new RegExp(`${REGISTER_FILE} is not a regular file`));
  });

  test('a register path that becomes a symbolic link is refused', () => {
    const remote = new Remote();
    const merged = remote.merge([[MAINTAINER, {[REGISTER_FILE]: {link: 'CLA.md'}}]]);
    refused(remote.backport(31, merged), remote, 31, new RegExp(`${REGISTER_FILE} is not a regular file`));
  });

  test('a rename out of a register path deletes it on release/latest; a rename back into it brings its new content', () => {
    const remote = new Remote();
    const out = remote.merge([[MAINTAINER, {'CLA.md': null, 'docs/CLA.md': 'CLA 1.0\n'}]]);
    assert.equal(git(remote.work, ['diff', '--find-renames', '--name-status', `${out.landed}^`, out.landed]), 'R100\tCLA.md\tdocs/CLA.md');
    const first = remote.backport(32, out);
    assert.equal(first.status, 0, first.output);
    assert.equal(git(remote.origin, ['diff', '--name-status', 'release/latest', BRANCH(32)]), 'D\tCLA.md', 'docs/CLA.md stays on main');
    remote.integrate(32);

    const back = remote.merge([[MAINTAINER, {'docs/CLA.md': null, 'CLA.md': 'CLA 1.0\n'}]]);
    const second = remote.backport(33, back);
    assert.equal(second.status, 0, second.output);
    assert.equal(git(remote.origin, ['diff', '--name-status', 'release/latest', BRANCH(33)]), 'A\tCLA.md');
    assert.equal(git(remote.origin, ['show', `${BRANCH(33)}:CLA.md`]), 'CLA 1.0');
  });

  // The script relies on "Rebase and merge": the landed commits are those of the pull request.
  test('a squash merge of a pull request of several commits is refused', () => {
    const remote = new Remote();
    const original = remote.merge([[CAROL, {'notes.txt': 'a\n'}], [CAROL, {'notes.txt': 'b\n'}]]).listed;
    const squash = remote.merge([[CAROL, {[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(CAROL)}`}]]);
    const result = remote.backport(34, {landed: squash.landed, count: 2, listed: original});
    refused(result, remote, 34, /the landed commits are not those of the pull request as a rebase merge lands them/);
    assert.equal(result.api.length, 2, 'the list of commits, then the files of the one with no landed commit');
  });

  test('a merge commit is refused', () => {
    const remote = new Remote();
    git(remote.work, ['checkout', '-q', '-b', 'topic', 'main']);
    const topic = remote.commit(CAROL, CAROL, {[REGISTER_FILE]: `${remote.read(REGISTER_FILE)}${row(CAROL)}`});
    git(remote.work, ['checkout', '-q', 'main']);
    remote.commit(MAINTAINER, MAINTAINER, {'src/meanwhile.ts': 'export {};\n'});
    git(remote.work, ['merge', '-q', '--no-ff', '--no-edit', 'topic'], {GIT_AUTHOR_NAME: MAINTAINER.name, GIT_AUTHOR_EMAIL: MAINTAINER.email,
      GIT_COMMITTER_NAME: MAINTAINER.name, GIT_COMMITTER_EMAIL: MAINTAINER.email});
    git(remote.work, ['push', '-q', 'origin', 'main']);
    const result = remote.backport(35, {landed: git(remote.work, ['rev-parse', 'HEAD']), count: 1, listed: [remote.listed(topic)]});
    refused(result, remote, 35, /the landed commits are not those of the pull request as a rebase merge lands them/);
  });
});
