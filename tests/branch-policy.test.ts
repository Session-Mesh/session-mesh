// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The branch policy checks (tools/branch-policy/branch-policy.ts and .github/workflows/branch-policy.yml):
// a pull request to main carries exactly one semver label, and a pull request to release/** is a
// backport of a pull request merged to main with `semver: patch`.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {blockOf, jobBlocks, parseLines} from './public-ci-workflow-lib.ts';
import {checkWorkflow} from './public-ci-workflow-checks.ts';
import {factsFromEvent, factsFromQueue, githubFactsLookup, githubFilesLookup, githubLookup, MAX_REFERENCES, queueEntryFromEvent, REGISTER_FILES, releaseGuardProblems, semverLabelProblems, type PullRequestFacts,
  type SourcePull}
  from '../tools/branch-policy/branch-policy.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'branch-policy', 'branch-policy.ts');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'branch-policy.yml');

const pull = (baseRef: string, labels: string[], body = ''): PullRequestFacts => ({baseRef, labels, body});
const merged = (labels: string[], baseRef = 'main', isMerged = true): SourcePull => ({merged: isMerged, baseRef, labels});
const PATCH = 'semver: patch';
const MINOR = 'semver: minor';

describe('semver label of a pull request to main', () => {
  const cases: [string, string[], boolean][] = [
    ['patch', [PATCH], true], ['minor', [MINOR], true], ['patch with other labels', [PATCH, 'bug', 'ci'], true],
    ['no label', [], false], ['other labels only', ['bug'], false], ['both', [PATCH, MINOR], false],
    ['a look-alike label', ['semver:patch'], false], ['a label of another case', ['Semver: Patch'], false],
  ];
  for (const [label, labels, ok] of cases) {
    test(`${label}: ${ok ? 'accepted' : 'refused'}`, () => {
      const problems = semverLabelProblems(pull('main', labels));
      assert.equal(problems.length === 0, ok, problems.join('\n'));
      if (!ok) assert.match(problems[0], /must carry exactly one of the labels "semver: patch".*"semver: minor"/);
    });
  }

  test('says whether none or both are present', () => {
    assert.match(semverLabelProblems(pull('main', []))[0], /carries neither/);
    assert.match(semverLabelProblems(pull('main', [PATCH, MINOR]))[0], /carries both/);
  });

  test('does not judge a pull request to another branch', () => {
    for (const base of ['release/latest', 'topic', 'Main', 'main/x']) assert.deepEqual(semverLabelProblems(pull(base, [])), [], base);
  });
});

describe('merge queue entry', () => {
  const SHA = 'a'.repeat(40);
  const event = (headRef: unknown) => ({merge_group: {head_ref: headRef}});

  test('the pull request number and base come from the queue branch name, with or without refs/heads/', () => {
    assert.deepEqual(queueEntryFromEvent(event(`refs/heads/gh-readonly-queue/main/pr-12-${SHA}`)), {baseRef: 'main', number: 12});
    assert.deepEqual(queueEntryFromEvent(event(`gh-readonly-queue/release/latest/pr-7-${SHA}`)), {baseRef: 'release/latest', number: 7});
  });

  test('anything else is not an entry (fail closed)', () => {
    const bad = [`refs/heads/main`, `gh-readonly-queue/main/pr-0-${SHA}`, `gh-readonly-queue/main/pr-07-${SHA}`, `gh-readonly-queue/main/pr--1-${SHA}`,
      `gh-readonly-queue/main/pr-1-${'A'.repeat(40)}`, `gh-readonly-queue/main/pr-1-${'a'.repeat(39)}`, `gh-readonly-queue/main/pr-1-${SHA}\n`,
      `x/gh-readonly-queue/main/pr-1-${SHA}`, `gh-readonly-queue//pr-1-${SHA}`, `gh-readonly-queue/main/pr-9999999999-${SHA}`, '', 5, null];
    for (const headRef of bad) assert.equal(queueEntryFromEvent(event(headRef)), null, String(headRef));
    assert.equal(queueEntryFromEvent({}), null);
    assert.equal(queueEntryFromEvent({merge_group: 'x'}), null);
    assert.equal(queueEntryFromEvent(null), null);
  });

  test('the facts are the pull request as it is now, and the same rules judge them as at its own event', async () => {
    const entry = {merge_group: {head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${SHA}`}};
    const lookup = (labels: string[], base = 'main') => async () => ({baseRef: base, labels, body: ''});
    assert.deepEqual(semverLabelProblems(await factsFromQueue(entry, lookup(['semver: patch']))), semverLabelProblems(pull('main', ['semver: patch'])));
    assert.deepEqual(semverLabelProblems(await factsFromQueue(entry, lookup([]))), semverLabelProblems(pull('main', [])));
    assert.equal(semverLabelProblems(await factsFromQueue(entry, lookup([]))).length, 1);
    await assert.rejects(factsFromQueue(entry, lookup([], 'release/latest')), /no longer targets/);
    await assert.rejects(factsFromQueue(entry, async () => null), /not a pull request of this repository/);
    await assert.rejects(factsFromQueue({merge_group: {head_ref: 'x'}}, lookup([])), /not a merge queue branch/);
  });

  test('githubFactsLookup reads labels, base and description, and refuses an answer that does not fit', async () => {
    const answer = (status: number, json: unknown) => (async () => new Response(JSON.stringify(json), {status})) as unknown as typeof fetch;
    const good = {number: 12, base: {ref: 'main'}, labels: [{name: 'semver: patch'}], body: null};
    assert.deepEqual(await githubFactsLookup('http://x', 'o/r', 't', answer(200, good))(12), {baseRef: 'main', labels: ['semver: patch'], body: '', number: 12});
    assert.equal(await githubFactsLookup('http://x', 'o/r', 't', answer(404, {}))(12), null);
    await assert.rejects(githubFactsLookup('http://x', 'o/r', 't', answer(500, {}))(12), /GitHub answered 500/);
    await assert.rejects(githubFactsLookup('http://x', 'o/r', 't', answer(200, {...good, number: 13}))(12), /unexpected answer/);
    await assert.rejects(githubFactsLookup('http://x', 'o/r', 't', answer(200, {...good, labels: [{name: 3}]}))(12), /unexpected answer/);
    await assert.rejects(githubFactsLookup('http://x', 'o/r', 't', answer(200, {...good, labels: undefined}))(12), /unexpected answer/);
  });
});

describe('release branch guard', () => {
  const lookupOf = (pulls: Record<number, SourcePull>) => async (number: number): Promise<SourcePull | null> => pulls[number] ?? null;
  const guard = (facts: PullRequestFacts, pulls: Record<number, SourcePull> = {}) => releaseGuardProblems(facts, lookupOf(pulls));
  const BODY = 'Backport of #12 to `release/latest`.\n\nCherry-picked.';

  test('accepts a backport of a pull request merged to main with semver: patch', async () => {
    assert.deepEqual(await guard(pull('release/latest', [PATCH], BODY), {12: merged([PATCH, 'bug'])}), []);
    assert.deepEqual(await guard(pull('release/0.2', [PATCH], '# Description\nBackport of #12 and Backport of #13'), {12: merged([PATCH]), 13: merged([PATCH])}), []);
  });

  test('refuses a pull request to a release branch without the label semver: patch', async () => {
    for (const labels of [[], [MINOR], ['bug']]) {
      const problems = await guard(pull('release/latest', labels, BODY), {12: merged([PATCH])});
      assert.equal(problems.length, 1);
      assert.match(problems[0], /must carry the label "semver: patch"/);
    }
  });

  test('refuses a description that references no pull request', async () => {
    for (const body of ['', 'A fix.', 'Backport #12', 'backport of #12', 'Backport of 12', 'See #12']) {
      const problems = await guard(pull('release/latest', [PATCH], body), {12: merged([PATCH])});
      assert.match(problems.join('\n'), /must say "Backport of #<number>"/, JSON.stringify(body));
    }
  });

  test('refuses a referenced pull request that is missing, not merged, not to main, or not a patch', async () => {
    const cases: [string, SourcePull | undefined, RegExp][] = [
      ['missing', undefined, /#12 is not a pull request of this repository/],
      ['open', merged([PATCH], 'main', false), /#12 is not merged/],
      ['merged to a release branch', merged([PATCH], 'release/latest'), /#12 was not merged to main/],
      ['merged to a topic branch', merged([PATCH], 'topic'), /#12 was not merged to main/],
      ['a minor change', merged([MINOR]), /#12 does not carry the label "semver: patch"/],
      ['unlabelled', merged([]), /#12 does not carry the label "semver: patch"/],
    ];
    for (const [label, source, pattern] of cases) {
      const problems = await guard(pull('release/latest', [PATCH], BODY), source ? {12: source} : {});
      assert.match(problems.join('\n'), pattern, label);
    }
  });

  test('refuses when one of several referenced pull requests is not a merged patch', async () => {
    const problems = await guard(pull('release/latest', [PATCH], 'Backport of #1\nBackport of #2'), {1: merged([PATCH]), 2: merged([MINOR])});
    assert.deepEqual(problems, ['#2 does not carry the label "semver: patch"']);
  });

  test('refuses a description naming more pull requests than a backport may', async () => {
    const body = Array.from({length: MAX_REFERENCES + 1}, (_, index) => `Backport of #${index + 1}`).join('\n');
    const calls: number[] = [];
    const problems = await releaseGuardProblems(pull('release/latest', [PATCH], body), async (number) => {
      calls.push(number);
      return merged([PATCH]);
    });
    assert.match(problems.join('\n'), /more than the 5 a backport may name/);
    assert.deepEqual(calls, [], 'no lookup for such a description');
  });

  test('does not judge a pull request to another branch', async () => {
    for (const base of ['main', 'topic', 'releases/0.1', 'pre-release/x']) assert.deepEqual(await guard(pull(base, [], '')), [], base);
  });

  test('looks each referenced pull request up once', async () => {
    const calls: number[] = [];
    await releaseGuardProblems(pull('release/latest', [PATCH], 'Backport of #3\nBackport of #3'), async (number) => {
      calls.push(number);
      return merged([PATCH]);
    });
    assert.deepEqual(calls, [3]);
  });
});

describe('release branch guard: a backport of the CLA register files', () => {
  const REGISTER_BODY = 'Backport of #20 to `release/latest`, restricted to the CLA register files.';
  const register = (number: number | undefined, files: Record<number, string[]>, sources: Record<number, SourcePull>) =>
    releaseGuardProblems({...pull('release/latest', [PATCH], REGISTER_BODY), ...(number === undefined ? {} : {number})},
      async (source) => sources[source] ?? null, async (which) => files[which] ?? []);

  test('accepts the register changes of a minor or unlabelled pull request that changed them', async () => {
    for (const labels of [[MINOR], []]) {
      assert.deepEqual(await register(30, {30: ['CLA-SIGNATORIES.md'], 20: ['src/feature.ts', 'CLA-SIGNATORIES.md']}, {20: merged(labels)}), [], labels.join());
    }
    assert.deepEqual(await register(30, {30: ['tools/cla-check/MAINTAINERS', 'CONTRIBUTORS.md', '.github/CODEOWNERS'],
      20: ['tools/cla-check/MAINTAINERS', 'CONTRIBUTORS.md', '.github/CODEOWNERS']}, {20: merged([MINOR])}), []);
  });

  test('refuses a backport of a minor pull request that also changes another file', async () => {
    const problems = await register(30, {30: ['CLA-SIGNATORIES.md', 'src/feature.ts'], 20: ['CLA-SIGNATORIES.md', 'src/feature.ts']}, {20: merged([MINOR])});
    assert.deepEqual(problems, ['#20 does not carry the label "semver: patch"']);
  });

  test('refuses a register-only backport of a minor pull request that changed no register file', async () => {
    const problems = await register(30, {30: ['CONTRIBUTORS.md'], 20: ['src/feature.ts']}, {20: merged([MINOR])});
    assert.deepEqual(problems, ['#20 does not carry the label "semver: patch"']);
  });

  test('refuses it without the number of the pull request, an empty list, or a source that is not merged to main', async () => {
    assert.equal((await register(undefined, {20: ['CONTRIBUTORS.md']}, {20: merged([MINOR])})).length, 1);
    assert.equal((await register(30, {20: ['CONTRIBUTORS.md']}, {20: merged([MINOR])})).length, 1);
    assert.match((await register(30, {30: ['CONTRIBUTORS.md'], 20: ['CONTRIBUTORS.md']}, {20: merged([MINOR], 'main', false)})).join(), /#20 is not merged/);
    assert.match((await register(30, {30: ['CONTRIBUTORS.md'], 20: ['CONTRIBUTORS.md']}, {20: merged([MINOR], 'topic')})).join(), /#20 was not merged to main/);
  });

  test('a register file renamed away counts under its former name', async () => {
    assert.deepEqual(await register(30, {30: ['CONTRIBUTORS.md'], 20: ['docs/people.md', 'CONTRIBUTORS.md']}, {20: merged([MINOR])}), []);
    assert.equal((await register(30, {30: ['CONTRIBUTORS.md', 'docs/people.md'], 20: ['CONTRIBUTORS.md']}, {20: merged([MINOR])})).length, 1);
  });

  test('looks the files up only when a source lacks semver: patch', async () => {
    const calls: number[] = [];
    await releaseGuardProblems({...pull('release/latest', [PATCH], 'Backport of #12'), number: 30}, async () => merged([PATCH]),
      async (number) => { calls.push(number); return []; });
    assert.deepEqual(calls, []);
  });

  test('names the five register files the cla check reads', () => {
    assert.deepEqual(REGISTER_FILES, ['CONTRIBUTORS.md', 'CLA.md', 'CLA-SIGNATORIES.md', 'tools/cla-check/MAINTAINERS', '.github/CODEOWNERS']);
  });
});

describe('the GitHub files lookup', () => {
  const pages = (lists: unknown[], status = 200): typeof fetch => {
    let call = 0;
    return (async () => new Response(JSON.stringify(lists[call++] ?? []), {status})) as unknown as typeof fetch;
  };
  const lookupWith = (fetchImpl: typeof fetch) => githubFilesLookup('https://api.example.test', 'owner/repo', 'token', fetchImpl)(7);
  const full = Array.from({length: 100}, (_, index) => ({filename: `f${index}`}));

  test('reads every page, a renamed file under both names, with the token', async () => {
    const urls: string[] = [];
    const spy = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
      return new Response(JSON.stringify(urls.length === 1 ? full : [{filename: 'CONTRIBUTORS.md', previous_filename: 'PEOPLE.md'}]), {status: 200});
    }) as unknown as typeof fetch;
    const files = await lookupWith(spy);
    assert.equal(files.length, 102);
    assert.deepEqual(files.slice(100), ['CONTRIBUTORS.md', 'PEOPLE.md']);
    assert.deepEqual(urls, ['https://api.example.test/repos/owner/repo/pulls/7/files?per_page=100&page=1',
      'https://api.example.test/repos/owner/repo/pulls/7/files?per_page=100&page=2']);
  });

  test('a failure, an unexpected shape or a list longer than GitHub gives is an error, never a partial list', async () => {
    await assert.rejects(lookupWith(pages([[]], 403)), /GitHub answered 403 for the files of pull request #7/);
    await assert.rejects(lookupWith(pages([[{name: 'x'}]])), /unexpected answer/);
    await assert.rejects(lookupWith(pages([{}])), /unexpected answer/);
    await assert.rejects(lookupWith(pages(Array.from({length: 31}, () => full))), /more files than GitHub lists/);
  });

  test('the event file gives the number of the pull request when it has one', () => {
    const event = (number: unknown) => ({pull_request: {number, base: {ref: 'release/latest'}, labels: [], body: ''}});
    assert.equal(factsFromEvent(event(30))?.number, 30);
    for (const bad of [undefined, '30', 0, -1, 1.5]) assert.equal(factsFromEvent(event(bad))?.number, undefined, String(bad));
  });
});

describe('the event file', () => {
  const event = (fields: object) => ({pull_request: {base: {ref: 'main'}, labels: [{name: PATCH}], body: 'text', ...fields}});

  test('gives the base branch, the label names and the description', () => {
    assert.deepEqual(factsFromEvent(event({})), {baseRef: 'main', labels: [PATCH], body: 'text'});
    assert.deepEqual(factsFromEvent(event({body: null})), {baseRef: 'main', labels: [PATCH], body: ''});
  });

  test('refuses what is not the event of a pull request', () => {
    for (const bad of [null, 'x', [], {}, {pull_request: null}, event({base: {}}), event({labels: 'x'}), event({labels: [{}]}), event({labels: [{name: 1}]})]) {
      assert.equal(factsFromEvent(bad), null, JSON.stringify(bad));
    }
  });
});

describe('the GitHub lookup', () => {
  const answer = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), {status})) as typeof fetch;
  const lookup = (fetchImpl: typeof fetch) => githubLookup('https://api.example.test', 'owner/repo', 'token', fetchImpl);

  test('reads merged, base branch and label names', async () => {
    const source = await lookup(answer(200, {merged: true, base: {ref: 'main'}, labels: [{name: PATCH}]}))(7);
    assert.deepEqual(source, {merged: true, baseRef: 'main', labels: [PATCH]});
  });

  test('sends the token, to the repository\'s pull request', async () => {
    let seen: {url: string; auth: string | null} = {url: '', auth: null};
    const spy = (async (url: string, init?: RequestInit) => {
      seen = {url, auth: new Headers(init?.headers).get('authorization')};
      return new Response(JSON.stringify({merged: false, base: {ref: 'x'}, labels: []}), {status: 200});
    }) as unknown as typeof fetch;
    await lookup(spy)(7);
    assert.deepEqual(seen, {url: 'https://api.example.test/repos/owner/repo/pulls/7', auth: 'Bearer token'});
  });

  test('a 404 is no pull request; any other failure or shape is an error, never an acceptance', async () => {
    assert.equal(await lookup(answer(404, {message: 'Not Found'}))(7), null);
    await assert.rejects(lookup(answer(403, {}))(7), /GitHub answered 403 for pull request #7/);
    await assert.rejects(lookup(answer(500, {}))(7), /GitHub answered 500/);
    await assert.rejects(lookup(answer(200, {merged: 'yes', base: {ref: 'main'}, labels: []}))(7), /unexpected answer/);
    await assert.rejects(lookup(answer(200, {merged: true, base: {}, labels: []}))(7), /unexpected answer/);
    await assert.rejects(lookup(answer(200, {merged: true, base: {ref: 'main'}, labels: [{name: 3}]}))(7), /unexpected answer/);
  });
});

describe('the command line', () => {
  let dir = '';
  let server: http.Server;
  let apiUrl = '';
  const pulls: Record<string, unknown> = {
    '/repos/owner/repo/pulls/12': {merged: true, base: {ref: 'main'}, labels: [{name: PATCH}]},
    '/repos/owner/repo/pulls/13': {merged: true, base: {ref: 'main'}, labels: [{name: MINOR}]},
    '/repos/owner/repo/pulls/13/files?per_page=100&page=1': [{filename: 'src/feature.ts'}, {filename: 'CLA-SIGNATORIES.md'}],
    '/repos/owner/repo/pulls/40/files?per_page=100&page=1': [{filename: 'CLA-SIGNATORIES.md'}],
    '/repos/owner/repo/pulls/41/files?per_page=100&page=1': [{filename: 'CLA-SIGNATORIES.md'}, {filename: 'src/feature.ts'}],
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'branch-policy-'));
    server = http.createServer((request, response) => {
      const found = pulls[request.url ?? ''];
      response.statusCode = request.headers.authorization === 'Bearer secret' ? (found ? 200 : 404) : 401;
      response.end(JSON.stringify(found ?? {}));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  });
  after(() => {
    server.close();
    fs.rmSync(dir, {recursive: true, force: true});
  });

  function run(command: string, event: unknown, env: NodeJS.ProcessEnv = {}): Promise<{status: number | null; output: string}> {
    const file = path.join(dir, 'event.json');
    fs.writeFileSync(file, typeof event === 'string' ? event : JSON.stringify(event));
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', TOOL, command], {env: {PATH: process.env.PATH ?? '', GITHUB_EVENT_PATH: file,
        GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 'secret', GITHUB_API_URL: apiUrl, ...env}});
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('close', (status) => resolve({status, output}));
    });
  }
  const event = (base: string, labels: string[], body = '') => ({pull_request: {base: {ref: base}, labels: labels.map((name) => ({name})), body}});

  test('semver-label: exit 0 with one label, 1 with none, and the message is a workflow error', async () => {
    const ok = await run('semver-label', event('main', [PATCH]));
    assert.equal(ok.status, 0, ok.output);
    const bad = await run('semver-label', event('main', []));
    assert.equal(bad.status, 1);
    assert.match(bad.output, /^::error title=semver-label::a pull request to main must carry exactly one of the labels/m);
  });

  test('release-guard: a valid backport passes, a minor source and an unknown number fail', async () => {
    const ok = await run('release-guard', event('release/latest', [PATCH], 'Backport of #12 to `release/latest`.'));
    assert.equal(ok.status, 0, ok.output);
    const minor = await run('release-guard', event('release/latest', [PATCH], 'Backport of #13'));
    assert.equal(minor.status, 1);
    assert.match(minor.output, /#13 does not carry the label "semver: patch"/);
    const unknown = await run('release-guard', event('release/latest', [PATCH], 'Backport of #99'));
    assert.equal(unknown.status, 1);
    assert.match(unknown.output, /#99 is not a pull request of this repository/);
  });

  test('release-guard: the register files of a minor pull request pass alone, not with another file', async () => {
    const numbered = (number: number) => ({pull_request: {...event('release/latest', [PATCH], 'Backport of #13').pull_request, number}});
    const ok = await run('release-guard', numbered(40));
    assert.equal(ok.status, 0, ok.output);
    const mixed = await run('release-guard', numbered(41));
    assert.equal(mixed.status, 1, mixed.output);
    assert.match(mixed.output, /#13 does not carry the label "semver: patch"/);
  });

  test('release-guard passes on a pull request to main without token or lookup', async () => {
    const result = await run('release-guard', event('main', []), {GITHUB_TOKEN: '', GITHUB_API_URL: 'http://127.0.0.1:1'});
    assert.equal(result.status, 0, result.output);
    const release = await run('release-guard', event('release/latest', [PATCH], 'Backport of #12'), {GITHUB_TOKEN: ''});
    assert.equal(release.status, 2, 'a backport without a token: a usage error, the guard does not guess');
  });

  test('release-guard: an unreachable or refusing API is an error (2), never an acceptance', async () => {
    const refused = await run('release-guard', event('release/latest', [PATCH], 'Backport of #12'), {GITHUB_TOKEN: 'wrong'});
    assert.equal(refused.status, 2, refused.output);
    assert.match(refused.output, /GitHub answered 401/);
    const down = await run('release-guard', event('release/latest', [PATCH], 'Backport of #12'), {GITHUB_API_URL: 'http://127.0.0.1:1'});
    assert.equal(down.status, 2, down.output);
  });

  test('usage errors and a file that is not a pull request event exit 2', async () => {
    assert.equal((await run('other', event('main', []))).status, 2);
    assert.equal((await run('semver-label', {})).status, 2);
    assert.equal((await run('semver-label', 'not json')).status, 2);
    assert.equal((await run('semver-label', event('main', []), {GITHUB_EVENT_PATH: path.join(dir, 'missing.json')})).status, 2);
  });

  test('prints only constants and numbers: a hostile label or branch name never reaches the output', async () => {
    const hostile = '::set-output name=x::y\n::error::injected';
    const result = await run('semver-label', event('main', [hostile]));
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.output, /injected|set-output/);
    const release = await run('release-guard', event(`release/${hostile}`, [hostile], hostile));
    assert.doesNotMatch(release.output, /injected|set-output/);
  });
});

describe('.github/workflows/branch-policy.yml', () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  const lines = parseLines(text);
  const job = (name: string) => jobBlocks(lines).find((item) => item.name === name)?.block.map((line) => line.raw).join('\n') ?? '';

  test('satisfies the policy profile', () => {
    assert.deepEqual(checkWorkflow(text, 'policy'), []);
  });

  test('runs on pull_request and the merge queue, again when a label changes or the base branch is edited, and never on a push', () => {
    assert.match(text, /^ {2}pull_request:\n(?: {4}#.*\n)* {4}types: \[opened, reopened, synchronize, edited, labeled, unlabeled\]\n/m);
    const onIndex = lines.findIndex((line) => line.indent === 0 && line.key === 'on');
    assert.deepEqual(blockOf(lines, onIndex).filter((line) => line.indent === 2).map((line) => line.key), ['pull_request', 'merge_group']);
  });

  test('has the two checks, each running on every pull request (a skipped job would pass a required check)', () => {
    assert.deepEqual(jobBlocks(lines).map((item) => item.name), ['semver-label', 'release-guard']);
    assert.match(job('semver-label'), /^ {4}name: semver label$/m);
    assert.match(job('release-guard'), /^ {4}name: release branch guard$/m);
    for (const name of ['semver-label', 'release-guard']) assert.doesNotMatch(job(name), /^ {4}if:/m, `${name} must never be skipped as a whole`);
  });

  test('runs the policy tool of the checkout on a pull request and the base\'s copy on the queue; the token only where the API is read', () => {
    assert.match(job('semver-label'), /node --experimental-strip-types tools\/branch-policy\/branch-policy\.ts semver-label$/m);
    assert.match(job('release-guard'), /node --experimental-strip-types tools\/branch-policy\/branch-policy\.ts release-guard$/m);
    const pullRequestStep = job('semver-label').split(/^ {6}- /m).find((step) => /branch-policy\.ts semver-label$/m.test(step) && !step.includes('"$tool"')) ?? '';
    assert.ok(pullRequestStep.length > 0);
    assert.doesNotMatch(pullRequestStep, /github\.token|GITHUB_TOKEN/, 'the label check of a pull request needs no token');
    for (const name of ['semver-label', 'release-guard']) {
      assert.match(job(name), /^ {10}GITHUB_TOKEN: \$\{\{ github\.token \}\}$/m);
      assert.match(job(name), /^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read$/m);
    }
    assert.match(text, /^permissions:\n {2}contents: read\n/m);
  });

  test('is refused when the run\'s token reaches an action, the whole workflow or a write scope', () => {
    const setupNode = '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version: ${{ env.NODE_VERSION }}\n';
    const faults: [string, string, RegExp][] = [
      ['the token under an action', text.replace(setupNode, '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        env:\n          GITHUB_TOKEN: ${{ github.token }}\n        with:\n          node-version: ${{ env.NODE_VERSION }}\n'), /explicit token/],
      ['the token for the whole workflow', text.replace('env:\n  NODE_VERSION: "24"', 'env:\n  NODE_VERSION: "24"\n  GITHUB_TOKEN: ${{ github.token }}'), /explicit token/],
      ['a write scope', text.replace('      pull-requests: read', '      pull-requests: write'), /pull-requests: write is not read-only/],
      ['a secret', text.replace('GITHUB_TOKEN: ${{ github.token }}', 'GITHUB_TOKEN: ${{ secrets.PAT }}'), /secret reference/],
      ['the description in an expression', text.replace('        run: node --experimental-strip-types tools/branch-policy/branch-policy.ts semver-label',
        '        run: echo "${{ github.event.pull_request.body }}"'), /untrusted event data/],
      ['pull_request_target', text.replace('  pull_request:\n', '  pull_request_target:\n'), /privileged trigger pull_request_target/],
    ];
    for (const [label, workflow, pattern] of faults) {
      assert.notEqual(workflow, text, `${label}: the edit did not apply`);
      const found = checkWorkflow(workflow, 'policy').join('\n');
      assert.ok(pattern.test(found), `${label} not reported:\n${found || '(no problem)'}`);
    }
  });
});

// CodeRabbit reviews the default branch; the backports to release/** are reviewed too
// (https://coderabbit.ai/integrations/schema.v2.json: reviews.auto_review.base_branches, regular expressions).
describe('.coderabbit.yaml', () => {
  const text = fs.readFileSync(path.join(ROOT, '.coderabbit.yaml'), 'utf8');

  test('automatic approvals require a current low-risk assessment and do not approve skipped reviews', () => {
    assert.match(text, /^ {2}fail_commit_status: true$/m);
    assert.match(text, /^ {2}auto_approvals:\n {4}enabled: true\n {4}approve_on_skipped_review: false\n {4}allow_author_approval: false\n {4}max_merge_risk: low$/m);
  });

  test('reviews the pull requests whose base is a release branch', () => {
    assert.match(text, /^ {2}auto_review:\n {4}enabled: true\n {4}drafts: false\n(?: {4}#.*\n)* {4}base_branches: \["release\/\.\*"\]\n/m);
    assert.ok(/^(?:release\/.*)$/.test('release/latest'));
    assert.ok(!/^(?:release\/.*)$/.test('pre-release/latest'));
  });
});
