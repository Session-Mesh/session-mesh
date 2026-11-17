// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The site deployment (.github/workflows/site.yml, GitHub Pages): its own rules on top of the `site`
// profile of tests/public-ci-workflow-checks.ts, and the file selection of
// .github/scripts/site-stage.sh, which must leave site/tools/ and site/README.md out of what is
// published.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe, test} from 'node:test';
import {checkWorkflow} from './public-ci-workflow-checks.ts';
import {blockOf, jobBlocks, parseLines} from './public-ci-workflow-lib.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'site.yml'), 'utf8');
// The same text without its comment lines, for the rules about what the workflow does.
const CODE = WORKFLOW.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
const STAGE_SCRIPT = path.join(ROOT, '.github', 'scripts', 'site-stage.sh');
const SITE = path.join(ROOT, 'site');
const NOT_PUBLISHED = ['tools', 'README.md'];
const PAGES_ACTIONS: Record<string, string> = {
  'actions/configure-pages': '45bfe0192ca1faeb007ade9deae92b16b8254a0d',
  'actions/upload-pages-artifact': 'fc324d3547104276b827a68afc52ff2a11cc49c9',
  'actions/deploy-pages': '368f82528645a54fb793d4d04e342629a3f51346',
};

function listFiles(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => entry.isDirectory()
    ? listFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]).sort();
}

// The permissions block of one job, as `scope: value` lines.
function jobPermissions(workflow: string, job: string): string[] {
  const lines = parseLines(workflow);
  const block = jobBlocks(lines).find((item) => item.name === job)?.block ?? [];
  const index = block.findIndex((line) => line.key === 'permissions');
  assert.ok(index >= 0, `job ${job} has no permissions block`);
  return blockOf(lines, lines.indexOf(block[index])).map((line) => `${line.key}: ${line.value}`);
}

describe('site.yml', () => {
  test('satisfies every invariant of the site profile', () => {
    assert.deepEqual(checkWorkflow(WORKFLOW, 'site'), []);
  });

  test('references no secret, no FTP or OVH setting, and has no mode input', () => {
    assert.doesNotMatch(WORKFLOW, /secrets[.[]/);
    assert.doesNotMatch(WORKFLOW, /ftp|lftp|ovh/i);
    assert.doesNotMatch(WORKFLOW, /^ {2}workflow_dispatch:\n {4}inputs:/m);
    assert.doesNotMatch(WORKFLOW, /\binputs\.|\bMODE\b/);
    assert.ok(checkWorkflow(`${WORKFLOW}\n# ${'$'}{{ secrets.X }}`, 'site').some((problem) => /secret reference/.test(problem)));
  });

  test('every action is pinned by full commit SHA, the three Pages actions to their known releases', () => {
    const uses = [...CODE.matchAll(/^\s+(?:- )?uses: (\S+)@(\S+) # (v\d+\.\d+\.\d+)$/gm)];
    assert.equal(uses.length, [...CODE.matchAll(/\buses:/g)].length, 'a `uses:` has no SHA and version comment');
    for (const [, action, sha] of uses) assert.match(sha, /^[0-9a-f]{40}$/, action);
    for (const [action, sha] of Object.entries(PAGES_ACTIONS)) {
      assert.ok(uses.some(([, name, pinned]) => name === action && pinned === sha), action);
    }
  });

  test('permissions: read-only at the top, read-only build job, pages and id-token write on the deploy job only', () => {
    assert.match(WORKFLOW, /^permissions:\n {2}contents: read\n/m);
    assert.deepEqual(jobPermissions(WORKFLOW, 'build'), ['contents: read']);
    assert.deepEqual(jobPermissions(WORKFLOW, 'deploy'), ['pages: write', 'id-token: write']);
    assert.deepEqual(jobBlocks(parseLines(WORKFLOW)).map((job) => job.name), ['build', 'deploy']);
    // Mutations: write access on the build job, an extra scope on the deploy job, and `write-all`.
    const buildWrite = WORKFLOW.replace('    permissions:\n      contents: read\n', '    permissions:\n      pages: write\n');
    assert.notEqual(buildWrite, WORKFLOW);
    assert.ok(checkWorkflow(buildWrite, 'site').some((problem) => /pages: write is not read-only/.test(problem)));
    const extra = WORKFLOW.replace('      id-token: write\n', '      id-token: write\n      contents: write\n');
    assert.notEqual(extra, WORKFLOW);
    assert.ok(checkWorkflow(extra, 'site').some((problem) => /contents: write is not read-only/.test(problem)));
    const top = WORKFLOW.replace('permissions:\n  contents: read\n\n', 'permissions: write-all\n\n');
    assert.notEqual(top, WORKFLOW);
    assert.ok(checkWorkflow(top, 'site').some((problem) => /write-all is not read-only/.test(problem)));
  });

  test('the public profile still refuses write permissions on any job', () => {
    assert.ok(checkWorkflow(WORKFLOW, 'public').some((problem) => /pages: write is not read-only/.test(problem)));
  });

  test('triggers: push to main on site/** and its own files, and a manual run without input', () => {
    assert.match(WORKFLOW, /^on:\n {2}push:\n {4}branches: \[main\]\n {4}paths:\n {6}- site\/\*\*\n {6}- \.github\/workflows\/site\.yml\n {6}- \.github\/scripts\/site-stage\.sh\n {2}workflow_dispatch:\n\npermissions:/m);
  });

  test('deployments never overlap and a running one is not cancelled; jobs have a timeout', () => {
    assert.match(WORKFLOW, /^concurrency:\n {2}group: site-deploy\n {2}cancel-in-progress: false\n/m);
    assert.equal([...WORKFLOW.matchAll(/^ {4}timeout-minutes: (?:[1-9]|10)$/gm)].length, 2);
  });

  test('the deploy job runs in the github-pages environment and needs the build', () => {
    const deploy = jobBlocks(parseLines(WORKFLOW)).find((job) => job.name === 'deploy')?.block.map((line) => line.text).join('\n') ?? '';
    assert.match(deploy, /^ {4}needs: build$/m);
    assert.match(deploy, /^ {4}environment:\n {6}name: github-pages\n {6}url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}$/m);
    assert.match(deploy, /^ {6}- id: deployment\n {8}uses: actions\/deploy-pages@/m);
    assert.doesNotMatch(deploy, /checkout/);
  });

  test('the build stages the site with the selection script, writes the CNAME and uploads that directory', () => {
    assert.match(CODE, /run: bash \.github\/scripts\/site-stage\.sh "\$RUNNER_TEMP\/site-stage"/);
    assert.match(CODE, /run: echo session-mesh\.com > "\$RUNNER_TEMP\/site-stage\/CNAME"/);
    assert.match(CODE, /upload-pages-artifact@[0-9a-f]{40} # v\S+\n\s+with:\n\s+path: \$\{\{ runner\.temp \}\}\/site-stage$/m);
    assert.ok(CODE.indexOf('site-stage.sh') < CODE.indexOf('/CNAME'));
    assert.ok(CODE.indexOf('/CNAME') < CODE.indexOf('upload-pages-artifact'));
  });

  test('the marker it looks for is in the home page', () => {
    const marker = /^ {2}SITE_MARKER: (.+)$/m.exec(WORKFLOW)?.[1];
    assert.ok(marker, 'no SITE_MARKER');
    assert.ok(fs.readFileSync(path.join(SITE, 'index.html'), 'utf8').includes(marker));
  });
});

describe('site-stage.sh (the files that are published)', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'site-stage-'));
  const staged = path.join(target, 'out');
  const result = spawnSync('bash', [STAGE_SCRIPT, staged], {encoding: 'utf8'});
  const names = result.status === 0 ? listFiles(staged) : [];

  test('succeeds', () => {
    assert.equal(result.status, 0, result.stderr);
  });

  test('leaves site/tools and site/README.md out', () => {
    assert.ok(names.length > 0);
    assert.ok(!names.some((name) => name === 'README.md' || name.startsWith('tools/')), names.join('\n'));
    for (const excluded of NOT_PUBLISHED) assert.ok(!fs.existsSync(path.join(staged, excluded)), excluded);
  });

  test('carries every other file of site/, byte for byte', () => {
    const expected = fs.readdirSync(SITE).filter((name) => !NOT_PUBLISHED.includes(name))
      .flatMap((name) => fs.statSync(path.join(SITE, name)).isDirectory()
        ? listFiles(path.join(SITE, name), `${name}/`) : [name]).sort();
    assert.deepEqual(names, expected);
    for (const name of expected) {
      assert.ok(fs.readFileSync(path.join(SITE, name)).equals(fs.readFileSync(path.join(staged, name))), name);
    }
    assert.ok(names.includes('index.html'));
  });

  test('the CNAME file the workflow adds is the domain alone, and site/ has none of its own', () => {
    assert.ok(!names.includes('CNAME'));
    const domain = /echo (\S+) > "\$RUNNER_TEMP\/site-stage\/CNAME"/.exec(CODE)?.[1];
    assert.equal(domain, 'session-mesh.com');
  });

  test('keeps the assets directory', () => {
    const assets = names.filter((name) => name.startsWith('assets/'));
    assert.ok(assets.length > 0);
  });

  test('refuses a target that is not empty', () => {
    const again = spawnSync('bash', [STAGE_SCRIPT, staged], {encoding: 'utf8'});
    assert.equal(again.status, 2);
    fs.rmSync(target, {recursive: true, force: true});
  });
});
