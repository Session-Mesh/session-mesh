// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// .github/scripts/apt-install.sh, run with a fake sudo, apt-get, python, sleep and mirror script on
// PATH: a mirror error is retried with apt-get update between attempts and the fallback mirror
// before the last one, any other apt error fails at once, the real install only runs once every
// package is downloaded, and when every attempt fails the job fails with one annotation naming
// the package mirror outage and the hosts in the errors.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {afterEach, beforeEach, describe, test} from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, '.github', 'scripts', 'apt-install.sh');

// What apt prints on 2026-11-19's failure: a 503 from security.ubuntu.com for a font package.
const FAKE_APT_GET = `
echo "apt-get $*" >> "$FAKE_LOG"
case "$1" in
  update)
    if [ "\${FAKE_UPDATE_FAIL:-0}" = 1 ]; then
      echo "Err:1 http://azure.archive.ubuntu.com/ubuntu noble InRelease"
      echo "  Could not connect to azure.archive.ubuntu.com:80 (1.2.3.4), connection timed out"
      exit 100
    fi
    # A fetch error that apt only reports as a warning unless --error-on=any is given.
    case "\${FAKE_UPDATE_KIND:-}" in
      thirdparty) echo "Err:4 https://packages.microsoft.com/repos noble InRelease"; echo "  Could not connect to packages.microsoft.com:443"; echo "W: Failed to fetch https://packages.microsoft.com/repos/dists/noble/InRelease"
        case "$*" in *--error-on=any*) echo "E: Some index files failed to download."; exit 100;; esac;;
      mirror) echo "Err:5 http://azure.archive.ubuntu.com/ubuntu noble-updates InRelease"; echo "W: Failed to fetch http://azure.archive.ubuntu.com/ubuntu/dists/noble-updates/InRelease"
        case "$*" in *--error-on=any*) echo "E: Some index files failed to download."; exit 100;; esac;;
      # The hosted runner's own source, which apt names by its list and not by a host.
      mirrorfile) echo "Err:2 mirror+file:/etc/apt/apt-mirrors.txt noble-updates InRelease"; echo "  Could not resolve 'azure.archive.ubuntu.com'"
        echo "W: Failed to fetch mirror+file:/etc/apt/apt-mirrors.txt/dists/noble-updates/InRelease  Could not resolve 'azure.archive.ubuntu.com'"
        case "$*" in *--error-on=any*) echo "E: Some index files failed to download."; exit 100;; esac;;
    esac
    exit 0;;
  install)
    case "$*" in
      *--download-only*)
        count=$(cat "$FAKE_COUNT" 2>/dev/null || echo 0); count=$((count + 1)); echo "$count" > "$FAKE_COUNT"
        if [ "$count" -le "\${FAKE_FAILURES:-0}" ]; then
          kind=$(echo "\${FAKE_KIND:-503}" | cut -d, -f"$count"); [ -n "$kind" ] || kind=$(echo "\${FAKE_KIND:-503}" | awk -F, '{print $NF}')
          case "$kind" in
            503)
              echo "Err:7 http://security.ubuntu.com/ubuntu noble-security/main amd64 fonts-ipafont-gothic all 00303-21"
              echo "  503  Service Unavailable [IP: 1.2.3.4 80]"
              echo "E: Failed to fetch http://security.ubuntu.com/ubuntu/pool/main/f/fonts-ipafont/fonts-ipafont-gothic_00303-21_all.deb  503  Service Unavailable"
              echo "E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?"
              exit 100;;
            # Lines of hosted runner logs during an outage of the image's mirror list.
            mirrorfile)
              echo "Err:2 mirror+file:/etc/apt/apt-mirrors.txt noble-updates/main amd64 bzip2-doc all 1.0.8-5.1build0.1"
              echo "  Temporary failure resolving 'azure.archive.ubuntu.com'"
              echo "E: Failed to fetch mirror+file:/etc/apt/apt-mirrors.txt/pool/main/b/bzip2/bzip2-doc_1.0.8-5.1build0.1_all.deb  Temporary failure resolving 'azure.archive.ubuntu.com'"
              echo "E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?"
              exit 100;;
            mirrorlist503)
              echo "Err:2 mirror+file:/etc/apt/apt-mirrors.txt noble-updates/main amd64 bzip2-doc all 1.0.8-5.1build0.1"
              echo "  503  Service Unavailable [IP: 1.2.3.4 80]"
              echo "E: Failed to fetch mirror+file:/etc/apt/apt-mirrors.txt/pool/main/b/bzip2/bzip2-doc_1.0.8-5.1build0.1_all.deb  503  Service Unavailable"
              exit 100;;
            # A 503, then apt's usual warning about its download sandbox: still a mirror error.
            503perm)
              echo "Err:7 http://security.ubuntu.com/ubuntu noble-security/main amd64 fonts-ipafont-gothic all 00303-21"
              echo "  503  Service Unavailable [IP: 1.2.3.4 80]"
              echo "W: Download is performed unsandboxed as root as file '/var/cache/apt/archives/partial/fonts-ipafont-gothic_00303-21_all.deb' couldn't be accessed by user '_apt'. - pkgAcquire::Run (13: Permission denied)"
              echo "E: Failed to fetch http://security.ubuntu.com/ubuntu/pool/main/f/fonts-ipafont/fonts-ipafont-gothic_00303-21_all.deb  503  Service Unavailable"
              exit 100;;
            azure) echo "E: Failed to fetch http://azure.archive.ubuntu.com/x.deb  503  Service Unavailable"; exit 100;;
            diskfull) echo "Err:7 http://azure.archive.ubuntu.com/ubuntu noble/main amd64 rsync amd64 1"; echo "  Write error - write (28: No space left on device)"; echo "E: Failed to fetch http://azure.archive.ubuntu.com/ubuntu/pool/main/r/rsync.deb  Write error - write (28: No space left on device)"; exit 100;;
            # The same, with the reason only on the indented line under Err:.
            diskfullerr) echo "Err:7 http://azure.archive.ubuntu.com/ubuntu noble/main amd64 rsync amd64 1"; echo "  Write error - write (28: No space left on device)"; echo "E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?"; exit 100;;
            typo) echo "E: Unable to locate package bubblewrapp"; exit 100;;
            locate) echo "E: Unable to locate package nope"; exit 100;;
            hang) exec env PATH=/usr/bin:/bin sleep 30;;
            # Ignores the TERM of timeout, so only the KILL after the grace period ends it.
            hangterm) trap '' TERM; exec env PATH=/usr/bin:/bin sleep 30;;
          esac
        fi
        exit 0;;
      *)
        [ "\${FAKE_INSTALL_FAIL:-0}" = 1 ] && { echo "E: Sub-process /usr/bin/dpkg returned an error code (1)"; exit 100; }
        exit 0;;
    esac;;
esac
exit 0`;

describe('apt-install.sh', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apt-install-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    const fake = (name: string, body: string) => fs.writeFileSync(path.join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`, {mode: 0o755});
    fake('sudo', 'echo "sudo $*" >> "$FAKE_LOG"; exec "$@"');
    fake('apt-get', FAKE_APT_GET);
    fake('sleep', 'echo "sleep $*" >> "$FAKE_LOG"');
    // Knows every package but those in FAKE_MISSING, as `apt-cache show` prints them.
    fake('apt-cache', 'package="${*: -1}"; case " ${FAKE_MISSING:-} " in *" $package "*) echo "N: Unable to locate package $package" >&2; exit 100;; esac; printf "Package: %s\\nVersion: 1\\n" "$package"; [ -z "${FAKE_BIG_SHOW:-}" ] || head -c 2000000 /dev/zero | tr "\\0" "x"');
    fake('python', 'echo "python $*" >> "$FAKE_LOG"; printf "%s\\n" "$FAKE_DRY_RUN"');
    fs.writeFileSync(path.join(dir, 'mirror.sh'), 'echo "mirror $*" >> "$FAKE_LOG"\n');
  });
  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

  const log = () => (fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8') : '');
  const calls = (prefix: string) => log().split('\n').filter((line) => line.startsWith(prefix));

  function run(args: string[], env: Record<string, string> = {}) {
    return spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, HOME: dir, FAKE_LOG: path.join(dir, 'log'),
        FAKE_COUNT: path.join(dir, 'count'), CI_APT_MIRROR_SCRIPT: path.join(dir, 'mirror.sh'), ...env,
      },
    });
  }

  test('a healthy mirror: update, download, then the real install, once, with no pause and no fallback', () => {
    const result = run(['bubblewrap', 'apparmor-profiles']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const apt = calls('apt-get');
    assert.deepEqual(apt.map((line) => line.split(' ').slice(0, 2).join(' ')), ['apt-get update', 'apt-get install', 'apt-get install']);
    assert.match(apt[1], /--download-only .*bubblewrap apparmor-profiles$/);
    assert.match(apt[2], /^apt-get install -y -q --no-install-recommends -o DPkg::Lock::Timeout=120 bubblewrap apparmor-profiles$/);
    assert.match(calls('sudo')[0], /^sudo timeout -k 30 120 apt-get update/);
    assert.match(calls('sudo')[1], /^sudo timeout -k 30 600 apt-get install/);
    assert.deepEqual(calls('sleep'), []);
    assert.deepEqual(calls('mirror'), []);
    assert.match(result.stdout, /installed on attempt 1 of 3/);
  });

  test('a mirror that fails twice: retried with an update each time, the pauses in order, the fallback before the last attempt', () => {
    const result = run(['fonts-ipafont-gothic'], {FAKE_FAILURES: '2'});
    assert.equal(result.status, 0, result.stdout);
    const order = log().split('\n').filter(Boolean).filter((line) => !line.startsWith('sudo'))
      .map((line) => (line.includes('--download-only') ? 'apt-get install --download-only' : line.replace(/^(apt-get \w+).*$/, '$1')));
    assert.deepEqual(order, [
      'apt-get update', 'apt-get install --download-only', 'sleep 30',
      'apt-get update', 'apt-get install --download-only', 'mirror --fallback', 'sleep 60',
      'apt-get update', 'apt-get install --download-only', 'apt-get install',
    ]);
    assert.match(result.stdout, /attempt 1 of 3 failed with a mirror error from security\.ubuntu\.com/);
    assert.match(result.stdout, /installed on attempt 3 of 3/);
    assert.doesNotMatch(result.stdout, /::error/);
  });

  test('a mirror that never answers: one error annotation that names the outage and the host, exit 1, no real install', () => {
    const result = run(['fonts-ipafont-gothic', 'unifont'], {FAKE_FAILURES: '9'});
    assert.equal(result.status, 1);
    const errors = result.stdout.split('\n').filter((line) => line.startsWith('::error'));
    assert.deepEqual(errors.length, 1);
    assert.match(errors[0], /^::error title=Package mirror unavailable::package mirror unavailable: 2 packages could not be downloaded in 3 attempts \(errors from security\.ubuntu\.com\)\. Probably not a code failure: re-run the job\.$/);
    assert.equal(calls('apt-get install').filter((line) => !line.includes('--download-only')).length, 0);
    assert.equal(calls('apt-get update').length, 3);
    assert.deepEqual(calls('mirror'), ['mirror --fallback']);
    assert.deepEqual(calls('sleep'), ['sleep 30', 'sleep 60']);
  });

  test('an update that cannot connect is a mirror error too', () => {
    const result = run(['rsync'], {FAKE_UPDATE_FAIL: '1', CI_APT_ATTEMPTS: '2'});
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error title=Package mirror unavailable::.*errors from azure\.archive\.ubuntu\.com/);
    assert.equal(calls('apt-get install').length, 0, 'no download after a failed update');
    assert.equal(calls('apt-get update').length, 2);
  });

  test('a download that exceeds its time bound is retried, then reported as a mirror outage', () => {
    const started = Date.now();
    const result = run(['musl-tools'], {FAKE_FAILURES: '9', FAKE_KIND: 'hang', CI_APT_DOWNLOAD_SECONDS: '1', CI_APT_ATTEMPTS: '2'});
    assert.equal(result.status, 1);
    assert.ok(Date.now() - started < 20_000, 'the bound must end the hung download');
    assert.match(result.stdout, /\(status 124\)/);
    assert.match(result.stdout, /::error title=Package mirror unavailable::/);
  });

  test('a hung download that ignores TERM is killed after the grace period (status 137) and still counts as the time bound', () => {
    const started = Date.now();
    const result = run(['musl-tools'], {FAKE_FAILURES: '9', FAKE_KIND: 'hangterm', CI_APT_DOWNLOAD_SECONDS: '1', CI_APT_KILL_GRACE: '1', CI_APT_ATTEMPTS: '1'});
    assert.equal(result.status, 1);
    assert.ok(Date.now() - started < 20_000, 'the KILL must end the hung download');
    assert.match(result.stdout, /failed with a mirror error \(status 137\)/);
    assert.match(result.stdout, /::error title=Package mirror unavailable::/);
    assert.match(calls('sudo')[1], /^sudo timeout -k 1 1 apt-get install/);
  });

  test('an outage of the runner image\'s mirror list (mirror+file:) during the download is retried, then names the list and the host', () => {
    const result = run(['bzip2-doc'], {FAKE_FAILURES: '9', FAKE_KIND: 'mirrorfile'});
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /::error title=Package mirror unavailable::.*\(errors from azure\.archive\.ubuntu\.com, mirror\+file:\/etc\/apt\/apt-mirrors\.txt\)/);
    assert.equal(calls('apt-get update').length, 3);
    assert.deepEqual(calls('mirror'), ['mirror --fallback']);
  });

  test('a mirror+file: error that names no host is a mirror error too, and recovers on the fallback', () => {
    const result = run(['bzip2-doc'], {FAKE_FAILURES: '2', FAKE_KIND: 'mirrorlist503'});
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /attempt 1 of 3 failed with a mirror error from mirror\+file:\/etc\/apt\/apt-mirrors\.txt \(status 100\)/);
    assert.deepEqual(calls('mirror'), ['mirror --fallback']);
    assert.match(result.stdout, /installed on attempt 3 of 3/);
  });

  test('an update that fails on the mirror+file: list fails the attempt, so --if-available never skips on a partial index', () => {
    const result = run(['rsync', '--if-available', 'darcs'], {FAKE_UPDATE_KIND: 'mirrorfile', FAKE_MISSING: 'darcs', CI_APT_ATTEMPTS: '2'});
    assert.equal(result.status, 1, result.stdout);
    assert.doesNotMatch(result.stdout, /hosts this script does not manage|skipping darcs/);
    assert.match(result.stdout, /::error title=Package mirror unavailable::.*errors from azure\.archive\.ubuntu\.com, mirror\+file:/);
    assert.equal(calls('apt-get install').length, 0);
  });

  test('apt\'s _apt sandbox warning (Permission denied) next to a real 503 does not hide the mirror error', () => {
    const result = run(['fonts-ipafont-gothic'], {FAKE_FAILURES: '1', FAKE_KIND: '503perm'});
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /attempt 1 of 3 failed with a mirror error from security\.ubuntu\.com/);
    assert.match(result.stdout, /installed on attempt 2 of 3/);
  });

  test('a mirror error in attempt 1 does not make an unknown package in attempt 2 look like a mirror error', () => {
    const result = run(['nope'], {FAKE_FAILURES: '9', FAKE_KIND: '503,locate'});
    assert.equal(result.status, 1);
    assert.match(result.stdout, /attempt 1 of 3 failed with a mirror error/);
    assert.match(result.stdout, /::error title=apt-get failed::apt-get failed with status 100 and no mirror error/);
    assert.equal(calls('apt-get update').length, 2);
    assert.deepEqual(calls('sleep'), ['sleep 30']);
  });

  test('an error that is not the mirror (an unknown package) fails at once, without retry and without blaming the mirror', () => {
    const result = run(['nope'], {FAKE_FAILURES: '9', FAKE_KIND: 'locate'});
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error title=apt-get failed::apt-get failed with status 100 and no mirror error/);
    assert.doesNotMatch(result.stdout, /mirror unavailable/);
    assert.equal(calls('apt-get update').length, 1);
    assert.deepEqual(calls('sleep'), []);
  });

  test('a third-party warning during update followed by a real typo fails at once as a non-mirror error, no retry', () => {
    const result = run(['bubblewrapp'], {FAKE_UPDATE_KIND: 'thirdparty', FAKE_FAILURES: '9', FAKE_KIND: 'typo'});
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error title=apt-get failed::apt-get failed with status 100 and no mirror error/);
    assert.match(result.stdout, /only from hosts this script does not manage/);
    assert.doesNotMatch(result.stdout, /mirror unavailable|packages\.microsoft\.com\)/);
    assert.equal(calls('apt-get update').length, 1);
    assert.deepEqual(calls('sleep'), []);
  });

  test('a third-party update warning alone does not stop a healthy install', () => {
    const result = run(['rsync'], {FAKE_UPDATE_KIND: 'thirdparty'});
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /installed on attempt 1 of 3/);
  });

  for (const kind of ['diskfull', 'diskfullerr']) {
    test(`a full disk during the download is not blamed on the mirror host it names (${kind})`, () => {
      const result = run(['rsync'], {FAKE_FAILURES: '9', FAKE_KIND: kind});
      assert.equal(result.status, 1);
      assert.match(result.stdout, /::error title=apt-get failed::/);
      assert.doesNotMatch(result.stdout.split('\n').filter((line) => line.startsWith('::error')).join('\n'), /mirror unavailable|azure/);
      assert.equal(calls('apt-get update').length, 1);
      assert.deepEqual(calls('sleep'), []);
    });
  }

  test('a mirror error that apt only warns about during update fails the attempt (--error-on=any), so --if-available never skips on a partial index', () => {
    const result = run(['rsync', '--if-available', 'darcs'], {FAKE_UPDATE_KIND: 'mirror', FAKE_MISSING: 'darcs', CI_APT_ATTEMPTS: '2'});
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error title=Package mirror unavailable::.*errors from azure\.archive\.ubuntu\.com/);
    assert.doesNotMatch(result.stdout, /skipping darcs/);
    assert.ok(calls('apt-get update').every((line) => line.includes('--error-on=any')));
    assert.equal(calls('apt-get install').length, 0);
  });

  test('the final annotation keeps every failing host seen across attempts, each once, even when the last attempt names none', () => {
    // Attempt 1: security.ubuntu.com; attempt 2: azure; attempt 3: a hang, which names no host.
    const result = run(['fonts-ipafont-gothic'], {FAKE_FAILURES: '9', FAKE_KIND: '503,azure,hang', CI_APT_DOWNLOAD_SECONDS: '1'});
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /\(errors from azure\.archive\.ubuntu\.com, security\.ubuntu\.com\)/);
    assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('::error')).length, 1);
  });

  test('apt-get is force-killed after its time bound, and the update takes the lock timeout too', () => {
    run(['rsync']);
    for (const line of calls('sudo').filter((entry) => !entry.startsWith('sudo apt-get install -y'))) assert.match(line, /^sudo timeout -k 30 \d+ apt-get /);
    assert.match(calls('apt-get update')[0], /-o DPkg::Lock::Timeout=120/);
  });

  test('CI_APT_MIRROR_DISABLE=1 also disables the fallback mirror', () => {
    const result = run(['bubblewrap'], {FAKE_FAILURES: '9', CI_APT_MIRROR_DISABLE: '1'});
    assert.equal(result.status, 1);
    assert.deepEqual(calls('mirror'), []);
    assert.equal(calls('apt-get update').length, 3);
  });

  test('a failure of the real install after the download is reported as such', () => {
    const result = run(['bubblewrap'], {FAKE_INSTALL_FAIL: '1'});
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error title=apt-get install failed::.*not a mirror outage/);
  });

  test('--if-available packages are installed only when the package index knows them (setup-ocaml: no darcs on 24.04)', () => {
    const result = run(['bubblewrap', 'musl-tools', 'rsync', '--if-available', 'darcs', 'gcc-multilib', 'mercurial'], {FAKE_MISSING: 'darcs'});
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /skipping darcs: not in the package index/);
    const install = calls('apt-get install');
    assert.equal(install.length, 2);
    for (const line of install) assert.match(line, / bubblewrap musl-tools rsync gcc-multilib mercurial$/);
  });

  test('a long apt-cache show output does not make a known optional package look unknown (no SIGPIPE under pipefail)', () => {
    const result = run(['rsync', '--if-available', 'gcc-multilib', 'mercurial'], {FAKE_BIG_SHOW: '1'});
    assert.equal(result.status, 0, result.stdout);
    assert.doesNotMatch(result.stdout, /skipping/);
    assert.match(calls('apt-get install').at(-1) ?? '', / rsync gcc-multilib mercurial$/);
  });

  test('only unavailable optional packages: nothing to install, success; an invalid optional name is refused', () => {
    const none = run(['--if-available', 'darcs'], {FAKE_MISSING: 'darcs'});
    assert.equal(none.status, 0, none.stdout);
    assert.match(none.stdout, /nothing to install/);
    assert.equal(calls('apt-get install').length, 0);
    const bad = run(['rsync', '--if-available', 'x;y']);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /not a package name: x;y/);
  });

  test('one attempt only: no pause and no fallback', () => {
    const result = run(['bubblewrap'], {FAKE_FAILURES: '9', CI_APT_ATTEMPTS: '1'});
    assert.equal(result.status, 1);
    assert.deepEqual(calls('sleep'), []);
    assert.deepEqual(calls('mirror'), []);
  });

  test('the last pause repeats when there are more retries than pauses', () => {
    const result = run(['bubblewrap'], {FAKE_FAILURES: '9', CI_APT_ATTEMPTS: '4', CI_APT_PAUSES: '5'});
    assert.equal(result.status, 1);
    assert.deepEqual(calls('sleep'), ['sleep 5', 'sleep 5', 'sleep 5']);
    assert.deepEqual(calls('mirror'), ['mirror --fallback']);
    assert.equal(log().split('\n').findIndex((line) => line === 'mirror --fallback'),
      log().split('\n').findLastIndex((line) => line === 'sleep 5') - 1, 'the fallback comes before the last attempt');
  });

  test('--playwright-deps installs the packages of playwright install-deps --dry-run', () => {
    const dryRun = 'sudo -- sh -c "apt-get update&& apt-get install -y --no-install-recommends libasound2t64 fonts-ipafont-gothic xvfb"';
    const result = run(['--playwright-deps', 'chromium'], {FAKE_DRY_RUN: dryRun});
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(calls('python'), ['python -m playwright install-deps --dry-run chromium']);
    assert.match(calls('apt-get install').at(-1) ?? '', / libasound2t64 fonts-ipafont-gothic xvfb$/);
    assert.match(result.stdout, /installing 3 packages/);
  });

  test('--playwright-deps refuses an output without the apt-get install line, and a bad package name', () => {
    const missing = run(['--playwright-deps', 'chromium'], {FAKE_DRY_RUN: 'BEWARE: your OS is not officially supported'});
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /::error title=apt-install could not list packages::/);
    const bad = run(['--playwright-deps', 'chromium'], {FAKE_DRY_RUN: 'sh -c "apt-get install -y --no-install-recommends ok; rm"'});
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /not a package name: ok;/);
    assert.deepEqual(calls('apt-get'), []);
  });

  test('refuses no package, an option in place of a package, and a malformed call', () => {
    for (const args of [[], ['-o', 'APT::Get::AllowUnauthenticated=true'], ['--playwright-deps']]) {
      const result = run(args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stdout, /^::error /m);
    }
    assert.deepEqual(calls('apt-get'), []);
  });

  test('never weakens signature checking', () => {
    const text = fs.readFileSync(SCRIPT, 'utf8').replace(/^#.*$/gm, '');
    assert.doesNotMatch(text, /trusted|allowinsecure|allow-unauthenticated|AllowUnauthenticated|--force-yes|allow-downgrades/i);
  });
});
