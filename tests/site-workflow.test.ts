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
const CSP_CHECK = path.join(ROOT, '.github', 'scripts', 'site-csp-check.mjs');
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
    assert.match(WORKFLOW, /^on:\n {2}push:\n {4}branches: \[main\]\n {4}paths:\n {6}- site\/\*\*\n {6}- \.github\/workflows\/site\.yml\n {6}- \.github\/scripts\/site-stage\.sh\n {6}- \.github\/scripts\/site-csp-check\.mjs\n {2}workflow_dispatch:\n\npermissions:/m);
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

describe('site-stage.sh Content Security Policy gate (positional whitelist)', () => {
  const HEAD = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'">';
  const OK_PAGE = `${HEAD}\n<title>t</title><script src="a.js"></script>`;
  const OK_SVG = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" aria-roledescription="flowchart"><!-- c --><path d="M0 0"/></svg>';
  const HOME = {'index.html': OK_PAGE};

  // A throwaway repository layout (the script finds site/ relative to its own place) with the given files.
  // A string starting with `link:` is a symbolic link to that target; a Buffer is written as it is.
  // With `main`, a second checkout (only its site/) is the reference, as in a preview; without it, the
  // reference is the checkout itself, as in site.yml after a merge.
  function stageWith(files: Record<string, string | Buffer>, main?: Record<string, string | Buffer>): {status: number | null; stderr: string} {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-stage-csp-'));
    try {
      fs.mkdirSync(path.join(root, '.github', 'scripts'), {recursive: true});
      fs.copyFileSync(STAGE_SCRIPT, path.join(root, '.github', 'scripts', 'site-stage.sh'));
      fs.copyFileSync(CSP_CHECK, path.join(root, '.github', 'scripts', 'site-csp-check.mjs'));
      const write = (checkout: string, tree: Record<string, string | Buffer>): void => {
        for (const [name, content] of Object.entries(tree)) {
          const file = path.join(checkout, 'site', name);
          fs.mkdirSync(path.dirname(file), {recursive: true});
          if (typeof content === 'string' && content.startsWith('link:')) fs.symlinkSync(content.slice(5), file);
          else fs.writeFileSync(file, content);
        }
      };
      write(root, files);
      if (main) write(path.join(root, 'main-checkout'), main);
      const args = [path.join(root, '.github', 'scripts', 'site-stage.sh'), path.join(root, 'out'), ...(main ? [path.join(root, 'main-checkout')] : [])];
      const run = spawnSync('bash', args, {encoding: 'utf8'});
      return {status: run.status, stderr: run.stderr};
    } finally {
      fs.rmSync(root, {recursive: true, force: true});
    }
  }

  function refused(files: Record<string, string | Buffer>, pattern: RegExp): void {
    const run = stageWith({...HOME, ...files});
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, pattern);
  }

  // The same in a preview: the pull request's files against the checkout of main (the home page and
  // `main`, which by default holds nothing else).
  function refusedBy(main: Record<string, string | Buffer>, files: Record<string, string | Buffer>, pattern: RegExp): void {
    const run = stageWith({...HOME, ...files}, {...HOME, ...main});
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, pattern);
  }

  test('accepts pages that start with the head of the home page, and a plain SVG', () => {
    const run = stageWith({...HOME, 'assets/other.html': `${HEAD}<body>anything <script>1</script></body>`, 'a.svg': OK_SVG, 'x.PNG': 'x'});
    assert.equal(run.status, 0, run.stderr);
  });

  test('accepts the real site/ apart from the two files the staging leaves out', () => {
    const real = spawnSync('node', [CSP_CHECK, path.join(SITE, 'index.html'), SITE, SITE], {encoding: 'utf8'});
    const lines = real.stderr.trim().split('\n').filter((line) => line && !/ (README\.md|tools\/[\w-]+\.mjs) has a file type/.test(line));
    assert.deepEqual(lines, []);
  });

  test('refuses a page that does not start with the head, whatever follows', () => {
    refused({'a.html': `<!-- x -->${HEAD}`}, /a\.html does not start with the head/);
    refused({'a.html': `﻿${HEAD}`}, /a\.html does not start/);
    refused({'a.html': HEAD.replace('Content-Security-Policy', 'content-security-policy')}, /a\.html does not start/);
    refused({'a.html': HEAD.replace('<meta charset="utf-8">\n', '')}, /a\.html does not start/);
    refused({'a.html': ''}, /a\.html does not start/);
  });

  test('refuses each bypass of the former tag reader', () => {
    const policy = HEAD.split('\n').at(-1) as string;
    const script = '<script>alert(1)</script>';
    const bypasses: Record<string, string> = {
      bang: `<!x ${policy}>${script}`, question: `<?x ${policy}>${script}`,
      endtag: `</ x ${policy}>${script}`, cdata: `<![CDATA[ ${policy} ]]>${script}`,
      quote: `<p x=a"><script>alert(1)</script>">${policy}`,
      noscript: `<noscript>${policy}</noscript>${script}`, template: `<template>${policy}</template>${script}`,
      xmp: `<xmp>${policy}</xmp>${script}`, body: `<body>${policy}${script}`,
      svgstyle: `<svg><style><script>alert(1)</script></style></svg>${policy}`,
    };
    for (const [name, page] of Object.entries(bypasses)) {
      const run = stageWith({...HOME, [`${name}.html`]: page});
      assert.equal(run.status, 1, name);
      assert.match(run.stderr, new RegExp(`${name}\\.html does not start`), name);
    }
  });

  test('refuses .htm and other file types, whatever their content', () => {
    for (const name of ['a.htm', 'a.HTM', 'a.shtml', 'a.svgz', 'a.php', 'a.md', 'noext', '.hidden', 'a.html.exe']) {
      refused({[name]: HEAD}, new RegExp(`${name.replaceAll('.', '\\.')} has a file type that is not allowed`));
    }
  });

  test('refuses a symbolic link to a file or to a directory, at any depth', () => {
    refused({'a.html': `link:${path.join(SITE, 'index.html')}`}, /a\.html is a symbolic link/);
    refused({'assets/b.png': 'link:/etc/hostname'}, /assets\/b\.png is a symbolic link/);
    refused({d: 'link:/tmp'}, /d is a symbolic link/);
    refused({'assets/d': 'link:..'}, /assets\/d is a symbolic link/);
  });

  test('refuses a NUL byte in a page', () => {
    refused({'a.html': Buffer.concat([Buffer.from(HEAD), Buffer.from([0]), Buffer.from('x')])}, /a\.html holds a NUL byte/);
  });

  // The bypasses of the former SVG blacklist, each of which ran a script in headless Chromium.
  const SVG_BYPASSES: Record<string, Buffer> = {
    'eacute.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" xmlns:é="http://www.w3.org/2000/svg"><é:script>1</é:script></svg>'),
    'cyrillic.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><а:script xmlns:а="http://www.w3.org/2000/svg">1</а:script></svg>'),
    'iso2022jp.svg': Buffer.from('<?xml version="1.0" encoding="ISO-2022-JP"?>\n<svg xmlns="http://www.w3.org/2000/svg"><scr\x1b(Bipt>1</scr\x1b(Bipt></svg>', 'latin1'),
    'plain.svg': Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
  };

  test('refuses a new SVG, whatever it holds, so that no bypass of a content scan exists', () => {
    for (const [name, content] of Object.entries(SVG_BYPASSES)) {
      refusedBy({}, {[name]: content}, new RegExp(`${name.replace('.', '\\.')} is not in main`));
    }
    refusedBy({}, {'a.svg': OK_SVG}, /a\.svg is not in main/);
  });

  test('refuses a changed SVG, even by one byte or into a bypass', () => {
    refusedBy({'a.svg': OK_SVG}, {'a.svg': `${OK_SVG}\n`}, /a\.svg differs from the file of main/);
    refusedBy({'a.svg': OK_SVG}, {'a.svg': SVG_BYPASSES['eacute.svg']}, /a\.svg differs from the file of main/);
    refusedBy({'a.svg': OK_SVG}, {'a.svg': SVG_BYPASSES['iso2022jp.svg']}, /a\.svg differs/);
  });

  test('refuses an SVG whose file of main is a symbolic link or a directory', () => {
    refusedBy({'a.svg': 'link:/etc/hostname'}, {'a.svg': OK_SVG}, /a\.svg differs from the file of main/);
    refusedBy({'a.svg/x.txt': 'x'}, {'a.svg': OK_SVG}, /a\.svg differs from the file of main/);
  });

  test('accepts an SVG byte-identical to the file of main, at any depth and in any case of extension', () => {
    const main = {'a.svg': OK_SVG, 'assets/agents/b.svg': SVG_BYPASSES['plain.svg'], 'c.SVG': OK_SVG};
    const run = stageWith({...HOME, ...main}, {...HOME, ...main});
    assert.equal(run.status, 0, run.stderr);
  });

  test('treats .xml and .xhtml like an SVG: only unchanged from main', () => {
    for (const name of ['a.xml', 'a.xhtml', 'a.XHTML']) {
      refusedBy({}, {[name]: HEAD}, new RegExp(`${name.replace('.', '\\.')} is not in main`));
      refusedBy({[name]: OK_SVG}, {[name]: HEAD}, new RegExp(`${name.replace('.', '\\.')} differs from the file of main`));
      const run = stageWith({...HOME, [name]: OK_SVG}, {...HOME, [name]: OK_SVG});
      assert.equal(run.status, 0, run.stderr);
    }
  });

  test('takes the policy reference from main, never from the pull request', () => {
    const weak = HEAD.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    assert.notEqual(weak, HEAD);
    // The pull request weakens the policy on every page of its own, home page included.
    const run = stageWith({'index.html': `${weak}\n<title>t</title>`, 'b.html': weak}, HOME);
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /^site-stage: index\.html does not start with the head/m);
    assert.match(run.stderr, /^site-stage: b\.html does not start with the head/m);
    // Without a reference of main, the same tree passes: the reference is read from where it is told.
    assert.equal(stageWith({'index.html': weak, 'b.html': weak}).status, 0);
    // A reference without a single policy tag refuses everything.
    const broken = stageWith(HOME, {'index.html': '<head></head>'});
    assert.equal(broken.status, 1, broken.stderr);
    assert.match(broken.stderr, /site\/index\.html has no single Content-Security-Policy/);
  });

  test('refuses a reference prefix with a non-ASCII or control byte', () => {
    for (const bad of ['é', '\x1b', '\0']) {
      const run = stageWith({'index.html': HEAD.replace('<head>', `<head>${bad}`)});
      assert.equal(run.status, 1, JSON.stringify(bad));
      assert.match(run.stderr, /site\/index\.html has no single Content-Security-Policy/);
    }
  });

  test('refuses a home page that has no single policy tag to take the prefix from', () => {
    for (const home of ['<head></head>', `${HEAD}${HEAD}`, '<meta http-equiv="Content-Security-Policy"']) {
      const run = stageWith({'index.html': home});
      assert.equal(run.status, 1, home);
      assert.match(run.stderr, /site\/index\.html has no single Content-Security-Policy/);
    }
  });
});

// The size caps of site-csp-check.mjs, run on a directory directly (the staging copy would itself read the
// files). Sparse files make a "large" file cost nothing; an unreadable one proves it is refused by its size
// without being read.
describe('site-csp-check.mjs size caps', () => {
  const MIB = 1024 * 1024;
  const HEAD = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'">';

  function check(build: (dir: string) => void): {status: number | null; stderr: string} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-csp-caps-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.html'), HEAD);
      build(dir);
      const run = spawnSync('node', [CSP_CHECK, path.join(dir, 'index.html'), dir, dir], {encoding: 'utf8'});
      return {status: run.status, stderr: run.stderr};
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  }
  const sparse = (dir: string, name: string, size: number, mode = 0o644): void => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '');
    fs.truncateSync(file, size);
    fs.chmodSync(file, mode);
  };

  test('accepts a file just under the cap and refuses one just over, without reading it', () => {
    assert.equal(check((dir) => sparse(dir, 'ok.png', 10 * MIB)).status, 0);
    // Mode 0: any attempt to read it would fail with EACCES instead of the size refusal.
    for (const name of ['big.png', 'big.html', 'big.svg']) {
      const run = check((dir) => sparse(dir, name, 10 * MIB + 1, 0o000));
      assert.equal(run.status, 1, run.stderr);
      assert.equal(run.stderr.trim(), `site-stage: ${name} is ${10 * MIB + 1} bytes, above the limit of ${10 * MIB} bytes per file`);
    }
  });

  test('refuses a tree above the total cap, and accepts one under it', () => {
    const fill = (count: number) => (dir: string): void => { for (let i = 0; i < count; i++) sparse(dir, `f${i}.png`, 10 * MIB, 0o000); };
    // index.html is a few bytes; ten files of exactly 10 MiB make the total exceed 100 MiB by those bytes.
    const over = check(fill(10));
    assert.equal(over.status, 1, over.stderr);
    assert.match(over.stderr.trim(), /^site-stage: the site is \d+ bytes, above the limit of 104857600 bytes in all$/);
    assert.equal(check(fill(9)).status, 0);
  });

  test('refuses more files than the count cap, and accepts that many', () => {
    const many = (count: number) => (dir: string): void => { for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), ''); };
    const over = check(many(5000));
    assert.equal(over.status, 1, over.stderr);
    assert.equal(over.stderr.trim(), 'site-stage: more than 5000 files and directories: a site that large cannot be previewed');
    assert.equal(check(many(4999)).status, 0);
  });
});
