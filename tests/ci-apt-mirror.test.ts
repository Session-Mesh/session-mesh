// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The shared apt step of the workflows (.github/scripts/fast-apt-mirror.sh): every Ubuntu job that
// installs packages runs it first, and the script itself, run with a fake sudo, apt-get and uname
// on PATH, keeps its promises: retries written, mirror switched, original restored when the mirror
// does not answer, idempotent, a no-op off Linux, and never a failing exit status.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {jobBlocks, parseLines} from './public-ci-workflow-lib.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, '.github', 'scripts', 'fast-apt-mirror.sh');
const WORKFLOWS = ['public-ci.yml', 'release.yml'];
const MIRROR_STEP = /fast-apt-mirror\.sh/;
// What installs packages: apt-get itself, setup-ocaml (29 packages through apt-get), playwright --with-deps.
const APT_USERS = /apt-get install|ocaml\/setup-ocaml|playwright install --with-deps/;

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

  function run(env: Record<string, string> = {}) {
    return spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, FAKE_LOG: path.join(dir, 'log'),
        CI_APT_CONF_FILE: conf(), CI_APT_SOURCES_FILE: path.join(dir, 'ubuntu.sources'), CI_APT_BACKUP_FILE: backup(),
        ...env,
      },
    });
  }

  test('writes retries and timeouts, switches the archive stanza only, and checks it with a bounded update', () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const written = fs.readFileSync(conf(), 'utf8');
    for (const setting of ['Acquire::Retries "3";', 'Acquire::http::Timeout "20";', 'Acquire::https::Timeout "20";']) {
      assert.ok(written.includes(setting), setting);
    }
    assert.ok(sources().includes('URIs: http://azure.archive.ubuntu.com/ubuntu/\n'));
    assert.ok(sources().includes('URIs: http://security.ubuntu.com/ubuntu/\n'), 'the security stanza keeps its URI');
    assert.ok(!sources().includes('apt-mirrors.txt'));
    assert.match(log(), /apt-get update .*Dir::Etc::sourcelist=.*ubuntu\.sources .*Dir::Etc::sourceparts=-/);
    assert.equal(fs.readFileSync(backup(), 'utf8'), original);
    assert.match(log(), /apt-get update .*APT::Get::List-Cleanup=0/, 'the check must not clean the lists');
  });

  test('only the archive URIs line changes: signatures, suites, components, types and the security stanza stay', () => {
    assert.equal(run().status, 0);
    const before = original.split('\n');
    const after = sources().split('\n');
    assert.equal(after.length, before.length);
    const changed = before.flatMap((line, index) => (line === after[index] ? [] : [[line, after[index]]]));
    assert.deepEqual(changed, [['URIs: mirror+file:/etc/apt/apt-mirrors.txt', 'URIs: http://azure.archive.ubuntu.com/ubuntu/']]);
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

  test('a security stanza on the mirror+file list is not moved to the new mirror, and a second run changes nothing', () => {
    const bothOnList = original.replace('URIs: http://security.ubuntu.com/ubuntu/', 'URIs: mirror+file:/etc/apt/apt-mirrors.txt');
    fs.writeFileSync(path.join(dir, 'ubuntu.sources'), bothOnList);
    assert.equal(run().status, 0);
    const after = sources();
    assert.ok(after.includes('URIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-backports'));
    assert.ok(after.includes('URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble-security'), 'the security stanza keeps its URI');
    assert.equal(after.split('\n').length, bothOnList.split('\n').length);
    assert.equal(fs.readFileSync(backup(), 'utf8'), bothOnList);
    assert.match(run().stdout, /already switched/);
    assert.equal(sources(), after);
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
