// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The shared apt steps of the workflows: every package installation goes through
// .github/scripts/apt-install.sh (no bare apt-get, no playwright --with-deps, setup-ocaml's packages
// installed first), every Ubuntu job that installs packages runs .github/scripts/fast-apt-mirror.sh
// first, and that script, run with a fake sudo, apt-get and uname on PATH, keeps its promises:
// retries written, mirror switched, original restored when the mirror does not answer, the
// --fallback mode, idempotent, a no-op off Linux, and never a failing exit status.
// tests/ci-apt-install.test.ts covers apt-install.sh itself.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {jobBlocks, parseLines, stepOf} from './public-ci-workflow-lib.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, '.github', 'scripts', 'fast-apt-mirror.sh');
const WORKFLOWS = ['public-ci.yml', 'release.yml'];
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const ALL_WORKFLOWS = fs.readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/.test(file));
const MIRROR_STEP = /fast-apt-mirror\.sh/;
// What installs packages: the retrying installer, and setup-ocaml (apt-get install for its packages).
const APT_USERS = /apt-install\.sh|ocaml\/setup-ocaml/;
// Package installs that bypass .github/scripts/apt-install.sh (no retries, no clear failure message).
const BARE_APT = /\bapt-get\b|\bapt\s+(?:install|update)\b|--with-deps|playwright\s+install-deps|\baptitude\b/;
// What setup-ocaml installs with a plain `apt-get --yes install` (packages/setup-ocaml/src/system-packages.ts
// at the pinned commit): bubblewrap, musl-tools, rsync, and darcs, g++-multilib, gcc-multilib and
// mercurial when apt knows them. A new pin must be checked against that file and this list updated.
const SETUP_OCAML_SHA = 'ff66428f72b64472e749b22e0ad4dded4b2ddca6';
const SETUP_OCAML_PACKAGES = 'run: bash .github/scripts/apt-install.sh bubblewrap musl-tools rsync darcs g++-multilib gcc-multilib mercurial';

describe('every package installation of the workflows goes through apt-install.sh', () => {
  for (const file of ALL_WORKFLOWS) {
    test(`${file} runs no bare apt-get, apt or playwright --with-deps`, () => {
      const lines = parseLines(fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8'));
      // Comments may name the commands; executed text may not (block scalars are read raw, minus shell comments).
      const offending = lines.filter((line) => BARE_APT.test(line.inBlock ? line.raw.replace(/(^|\s)#.*$/, '') : line.text));
      assert.deepEqual(offending.map((line) => `line ${line.number}: ${line.raw.trim()}`), []);
    });
  }

  test('the check itself catches the forms it is meant to refuse', () => {
    for (const bad of ['sudo apt-get install -y foo', 'sudo apt-get update -q', 'sudo apt install foo',
      'python -m playwright install --with-deps chromium', 'npx playwright install-deps chromium']) {
      assert.match(bad, BARE_APT, bad);
    }
    assert.doesNotMatch('bash .github/scripts/apt-install.sh --playwright-deps chromium', BARE_APT);
    assert.doesNotMatch('python -m playwright install chromium', BARE_APT);
  });

  test('every Ubuntu setup-ocaml step is the reviewed pin, preceded by its packages installed with retries', () => {
    let seen = 0;
    for (const file of WORKFLOWS) {
      const lines = parseLines(fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8'));
      for (const {name, block} of jobBlocks(lines)) {
        const runsOn = block.find((line) => line.key === 'runs-on')?.value ?? '';
        if (runsOn.includes('macos')) continue;
        const ocaml = block.findIndex((line) => /ocaml\/setup-ocaml@/.test(line.text));
        if (ocaml < 0) continue;
        seen++;
        assert.ok(block[ocaml].text.includes(`ocaml/setup-ocaml@${SETUP_OCAML_SHA}`),
          `${file} job ${name}: a new setup-ocaml pin, check its system-packages.ts against SETUP_OCAML_PACKAGES`);
        const packages = block.findIndex((line) => line.text.trim() === SETUP_OCAML_PACKAGES);
        assert.ok(packages >= 0 && packages < ocaml, `${file} job ${name}: setup-ocaml's packages must be installed first`);
        // The two steps run under the same condition (the native job skips both on a cache hit).
        const conditionOf = (index: number) => stepOf(block, index).find((line) => line.key === 'if')?.value ?? '';
        assert.equal(conditionOf(packages), conditionOf(ocaml), `${file} job ${name}: different conditions`);
      }
    }
    assert.ok(seen >= 2, 'the ocaml and native jobs run setup-ocaml');
  });

  test('the browser job installs Chromium without --with-deps and its system packages with retries', () => {
    const text = fs.readFileSync(path.join(WORKFLOW_DIR, 'public-ci.yml'), 'utf8');
    assert.ok(text.includes('python -m playwright install chromium\n'));
    assert.ok(text.includes('run: bash .github/scripts/apt-install.sh --playwright-deps chromium\n'));
    assert.match(text, /path: ~\/\.cache\/ms-playwright\n\s+key: playwright-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\('requirements-browser\.txt'\) \}\}/);
    assert.match(fs.readFileSync(path.join(ROOT, 'requirements-browser.txt'), 'utf8'), /^playwright==\d+\.\d+\.\d+$/m,
      'the cache key covers the Playwright version only if requirements-browser.txt pins it');
  });

  test('no step hides an installation failure', () => {
    for (const file of ALL_WORKFLOWS) {
      const lines = parseLines(fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8'));
      lines.forEach((line, index) => {
        if (!/apt-install\.sh/.test(line.text) || line.text.trimStart().startsWith('#')) return;
        assert.ok(!stepOf(lines, index).some((other) => other.key === 'continue-on-error'), `${file} line ${line.number}`);
        assert.doesNotMatch(line.raw, /\|\|\s*true|;\s*true\b/, `${file} line ${line.number}`);
      });
    }
  });
});

describe('workflows run the apt mirror step before any package installation', () => {
  for (const file of WORKFLOWS) {
    const lines = parseLines(fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8'));
    for (const {name, block} of jobBlocks(lines)) {
      const runsOn = block.find((line) => line.key === 'runs-on')?.value ?? '';
      if (!runsOn.includes('ubuntu') && !runsOn.includes('matrix.runner')) continue;
      const first = (pattern: RegExp) => block.findIndex((line) => pattern.test(line.text));
      const mirror = first(MIRROR_STEP);
      const user = first(APT_USERS);
      if (user < 0 && mirror < 0) continue;
      test(`${file} job ${name}`, () => {
        assert.ok(user >= 0, 'the mirror step is there but nothing installs packages');
        assert.ok(mirror >= 0, `${file} job ${name} installs packages without the apt mirror step`);
        assert.ok(mirror < user, `${file} job ${name}: the mirror step must come before the first package installation`);
      });
    }
  }

  test('the macOS jobs are untouched', () => {
    for (const file of WORKFLOWS) {
      const lines = parseLines(fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8'));
      for (const {name, block} of jobBlocks(lines)) {
        if (!block.some((line) => line.key === 'runs-on' && line.value.includes('macos'))) continue;
        assert.ok(!block.some((line) => MIRROR_STEP.test(line.text)), `${file} job ${name} runs on macOS`);
      }
    }
  });

  test('the step runs the script with plain bash and no expression', () => {
    for (const file of WORKFLOWS) {
      const text = fs.readFileSync(path.join(ROOT, '.github', 'workflows', file), 'utf8');
      for (const line of text.split('\n').filter((raw) => MIRROR_STEP.test(raw) && !raw.trimStart().startsWith('#'))) {
        assert.equal(line.trim(), 'run: bash .github/scripts/fast-apt-mirror.sh');
      }
    }
  });
});

describe('fast-apt-mirror.sh', () => {
  let dir: string;
  // Structure of Ubuntu 24.04's /etc/apt/sources.list.d/ubuntu.sources, with the hosted runner's mirror+file URI.
  const keyring = 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg';
  const original = [
    '## Ubuntu distribution repository', '##',
    '## The following settings can be adjusted to configure which packages to use from Ubuntu.', '',
    'Types: deb', 'URIs: mirror+file:/etc/apt/apt-mirrors.txt', 'Suites: noble noble-updates noble-backports',
    'Components: main universe restricted multiverse', keyring, '',
    '## Ubuntu security updates. Aside from URIs and Suites,', '## this should mirror your choices in the previous section.',
    'Types: deb', 'URIs: http://security.ubuntu.com/ubuntu/', 'Suites: noble-security',
    'Components: main universe restricted multiverse', keyring, '',
  ].join('\n');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-apt-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    const fake = (name: string, body: string) => fs.writeFileSync(path.join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`, {mode: 0o755});
    fake('sudo', 'echo "sudo $*" >> "$FAKE_LOG"; [ "${FAKE_RESTORE_FAIL:-0}" = 1 ] && [ "$1" = cp ] && case "$4" in *ubuntu.sources) exit 1;; esac; exec "$@"');
    fake('apt-get', 'echo "apt-get $*" >> "$FAKE_LOG"; [ "${FAKE_APT_SOFTFAIL:-0}" = 1 ] && case "$*" in *--error-on=any*) exit 100;; esac; [ "${FAKE_APT_FAIL:-0}" = 1 ] && exit 100; [ "${FAKE_APT_HANG:-0}" = 1 ] && sleep 30; exit 0');
    fake('uname', 'case "$1" in -s) echo "${FAKE_OS:-Linux}";; -m) echo "${FAKE_ARCH:-x86_64}";; esac');
    fs.writeFileSync(path.join(dir, 'ubuntu.sources'), original);
  });
  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

  const sources = () => fs.readFileSync(path.join(dir, 'ubuntu.sources'), 'utf8');
  const conf = () => path.join(dir, 'retries.conf');
  const backup = () => path.join(dir, 'ubuntu.sources.ci-original');
  const log = () => (fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8') : '');

  function run(env: Record<string, string> = {}, args: string[] = []) {
    return spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, FAKE_LOG: path.join(dir, 'log'),
        CI_APT_CONF_FILE: conf(), CI_APT_SOURCES_FILE: path.join(dir, 'ubuntu.sources'), CI_APT_BACKUP_FILE: backup(),
        ...env,
      },
    });
  }

  test('writes retries and timeouts, switches the archive and security stanzas, and checks them with a bounded update', () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const written = fs.readFileSync(conf(), 'utf8');
    for (const setting of ['Acquire::Retries "3";', 'Acquire::http::Timeout "20";', 'Acquire::https::Timeout "20";']) {
      assert.ok(written.includes(setting), setting);
    }
    assert.ok(sources().includes('URIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-backports'));
    assert.ok(sources().includes('URIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble-security'), 'security.ubuntu.com is moved too');
    assert.ok(!sources().includes('apt-mirrors.txt'));
    assert.ok(!sources().includes('security.ubuntu.com'));
    assert.match(log(), /apt-get update .*Dir::Etc::sourcelist=.*ubuntu\.sources .*Dir::Etc::sourceparts=-/);
    assert.equal(fs.readFileSync(backup(), 'utf8'), original);
    assert.match(log(), /apt-get update .*APT::Get::List-Cleanup=0/, 'the check must not clean the lists');
  });

  test('only the two URIs lines change: signatures, suites, components and types stay', () => {
    assert.equal(run().status, 0);
    const before = original.split('\n');
    const after = sources().split('\n');
    assert.equal(after.length, before.length);
    const changed = before.flatMap((line, index) => (line === after[index] ? [] : [[line, after[index]]]));
    assert.deepEqual(changed, [['URIs: mirror+file:/etc/apt/apt-mirrors.txt', 'URIs: http://azure.archive.ubuntu.com/ubuntu/'],
      ['URIs: http://security.ubuntu.com/ubuntu/', 'URIs: http://azure.archive.ubuntu.com/ubuntu/']]);
    assert.equal(after.filter((line) => line === keyring).length, 2, 'both stanzas keep Signed-By');
    assert.ok(!/trusted|allowinsecure|allow-unauthenticated/i.test(sources()));
  });

  test('the script never weakens signature checking', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(!/trusted|allowinsecure|allow-unauthenticated|signed-by|gpg|keyring/i.test(text.replace(/^#.*$/gm, '')));
  });

  test('a failed restore is reported, not hidden: a second run does not claim the mirror is switched', () => {
    const first = run({FAKE_APT_FAIL: '1', FAKE_RESTORE_FAIL: '1'});
    assert.equal(first.status, 0);
    assert.match(first.stdout, /restore failed/);
    assert.ok(fs.existsSync(backup()), 'the backup stays');
    const updates = log().split('\n').filter((line) => line.startsWith('apt-get')).length;
    const second = run({FAKE_APT_FAIL: '1', FAKE_RESTORE_FAIL: '1'});
    assert.equal(second.status, 0);
    assert.match(second.stdout, /earlier restore failed/);
    assert.ok(!/already switched/.test(second.stdout));
    assert.equal(log().split('\n').filter((line) => line.startsWith('apt-get')).length, updates);
  });

  test('a stale backup next to a sources file that is not switched is not called switched', () => {
    fs.writeFileSync(backup(), original);
    const result = run();
    assert.equal(result.status, 0);
    assert.ok(!/already switched/.test(result.stdout));
    assert.match(result.stdout, /not switched/);
    assert.equal(sources(), original);
  });

  test('a second run reports a real switch as already switched', () => {
    assert.equal(run().status, 0);
    assert.match(run().stdout, /already switched/);
  });

  test('a security stanza on the mirror+file list moves as well, and a second run changes nothing', () => {
    const bothOnList = original.replace('URIs: http://security.ubuntu.com/ubuntu/', 'URIs: mirror+file:/etc/apt/apt-mirrors.txt');
    fs.writeFileSync(path.join(dir, 'ubuntu.sources'), bothOnList);
    assert.equal(run().status, 0);
    const after = sources();
    assert.ok(after.includes('URIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-backports'));
    assert.ok(after.includes('URIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble-security'));
    assert.equal(after.split('\n').length, bothOnList.split('\n').length);
    assert.equal(fs.readFileSync(backup(), 'utf8'), bothOnList);
    assert.match(run().stdout, /already switched/);
    assert.equal(sources(), after);
  });

  test('a URI that is not Ubuntu\'s (a third-party repository) is left alone', () => {
    const withOther = `${original}\nTypes: deb\nURIs: https://packages.example.org/apt/\nSuites: stable\nComponents: main\n`;
    fs.writeFileSync(path.join(dir, 'ubuntu.sources'), withOther);
    assert.equal(run().status, 0);
    assert.ok(sources().includes('URIs: https://packages.example.org/apt/\n'));
    assert.equal(run({}, ['--fallback']).status, 0);
    assert.ok(sources().includes('URIs: https://packages.example.org/apt/\n'));
  });

  test('--fallback points every Ubuntu URI at archive.ubuntu.com, keeps the backup, and exits 0', () => {
    assert.equal(run().status, 0);
    const updates = log().split('\n').filter((line) => line.startsWith('apt-get')).length;
    const result = run({}, ['--fallback']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /fallback: the Ubuntu URIs now name http:\/\/archive\.ubuntu\.com\/ubuntu\//);
    const after = sources();
    assert.equal(after.split('\n').filter((line) => line === 'URIs: http://archive.ubuntu.com/ubuntu/').length, 2);
    assert.ok(!after.includes('azure'));
    assert.equal(fs.readFileSync(backup(), 'utf8'), original, 'the original stays in the backup');
    assert.equal(log().split('\n').filter((line) => line.startsWith('apt-get')).length, updates, 'no check of its own: the caller updates next');
  });

  test('--fallback also works on the runner\'s own sources (after a restore) and is a no-op off x86_64 or Linux', () => {
    assert.equal(run({}, ['--fallback']).status, 0);
    assert.ok(!sources().includes('apt-mirrors.txt') && !sources().includes('security.ubuntu.com'));
    fs.writeFileSync(path.join(dir, 'ubuntu.sources'), original);
    assert.equal(run({FAKE_ARCH: 'aarch64'}, ['--fallback']).status, 0);
    assert.equal(run({FAKE_OS: 'Darwin'}, ['--fallback']).status, 0);
    assert.equal(run({CI_APT_MIRROR_DISABLE: '1'}, ['--fallback']).status, 0);
    assert.equal(sources(), original);
  });

  test('replaces a regional archive host as well', () => {
    fs.writeFileSync(path.join(dir, 'ubuntu.sources'), original.replace('mirror+file:/etc/apt/apt-mirrors.txt', 'http://us-east-2.ec2.archive.ubuntu.com/ubuntu/'));
    assert.equal(run().status, 0);
    assert.ok(sources().includes('URIs: http://azure.archive.ubuntu.com/ubuntu/\n'));
    assert.ok(!sources().includes('ec2'));
  });

  test('restores the original sources when the new mirror does not answer, and still exits 0', () => {
    const result = run({FAKE_APT_FAIL: '1'});
    assert.equal(result.status, 0);
    assert.equal(sources(), original);
    assert.ok(!fs.existsSync(backup()), 'the backup is consumed by the restore');
    assert.ok(fs.existsSync(conf()), 'the retries stay');
  });

  test('a fetch error that apt only warns about (exit 0 unless --error-on=any) still restores the original sources', () => {
    const result = run({FAKE_APT_SOFTFAIL: '1'});
    assert.equal(result.status, 0);
    assert.match(log(), /apt-get update .*--error-on=any/);
    assert.equal(sources(), original);
    assert.ok(!fs.existsSync(backup()));
  });

  test('the default configuration file sorts after the runner image zz-retries', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8');
    const name = /CI_APT_CONF_FILE:-\/etc\/apt\/apt\.conf\.d\/([^}]+)}/.exec(text)?.[1];
    assert.ok(name && name > 'zz-retries', `${name} must sort after zz-retries`);
  });

  test('restores the original sources when the check exceeds its bound', () => {
    const result = run({FAKE_APT_HANG: '1', CI_APT_CHECK_SECONDS: '1'});
    assert.equal(result.status, 0);
    assert.equal(sources(), original);
  });

  test('is idempotent: a second run changes nothing and runs no second update', () => {
    assert.equal(run().status, 0);
    const after = sources();
    const updates = log().split('\n').filter((line) => line.startsWith('apt-get')).length;
    assert.equal(run().status, 0);
    assert.equal(sources(), after);
    assert.equal(log().split('\n').filter((line) => line.startsWith('apt-get')).length, updates);
  });

  test('is a no-op off Linux', () => {
    const result = run({FAKE_OS: 'Darwin'});
    assert.equal(result.status, 0);
    assert.ok(!fs.existsSync(conf()));
    assert.equal(sources(), original);
    assert.equal(log(), '');
  });

  test('on another architecture it writes the retries and leaves the mirror alone', () => {
    assert.equal(run({FAKE_ARCH: 'aarch64'}).status, 0);
    assert.ok(fs.existsSync(conf()));
    assert.equal(sources(), original);
    assert.ok(!log().includes('apt-get'));
  });

  test('without ubuntu.sources it writes the retries and exits 0', () => {
    fs.rmSync(path.join(dir, 'ubuntu.sources'));
    assert.equal(run().status, 0);
    assert.ok(fs.existsSync(conf()));
  });

  test('can be disabled', () => {
    assert.equal(run({CI_APT_MIRROR_DISABLE: '1'}).status, 0);
    assert.ok(!fs.existsSync(conf()));
    assert.equal(sources(), original);
  });

  test('fails open when it cannot write the configuration', () => {
    const result = run({CI_APT_CONF_FILE: path.join(dir, 'missing', 'dir', 'retries.conf')});
    assert.equal(result.status, 0);
    assert.equal(sources(), original);
  });
});
