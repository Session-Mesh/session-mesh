// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// scripts/bundle/python-download-url.sh reads the output of `uv python list <version>
// --only-downloads --show-urls`. The samples are real uv 0.7.2 output (the version the release
// pins), as printed on Linux and, for macOS, as printed for the macos-aarch64 platform; the coloured
// sample is the output under CLICOLOR_FORCE=1, which the macOS release job sets and which wrapped the
// URL in SGR escapes (release run 44094751641: "uv names no python-build-standalone download").
// Every URL must also resolve to a pinned licence archive in scripts/bundle/python-licenses.sha256,
// by the same release and platform triple that scripts/build-bundle.sh extracts.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const BASE = 'https://github.com/astral-sh/python-build-standalone/releases/download/20250317';
const ESC = '\u001b';

const URLS = {
  linuxX86: `${BASE}/cpython-3.12.9%2B20250317-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz`,
  linuxArm: `${BASE}/cpython-3.12.9%2B20250317-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz`,
  macosArm: `${BASE}/cpython-3.12.9%2B20250317-aarch64-apple-darwin-install_only_stripped.tar.gz`,
  macosX86: `${BASE}/cpython-3.12.9%2B20250317-x86_64-apple-darwin-install_only_stripped.tar.gz`,
};

function parse(input: string): string {
  const ran = spawnSync('bash', [path.join(REPO, 'scripts', 'bundle', 'python-download-url.sh')], {input, encoding: 'utf8'});
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout;
}

const SAMPLES: Record<string, {input: string; url: string}> = {
  'Linux x86_64': {input: `cpython-3.12.9-linux-x86_64-gnu    ${URLS.linuxX86}\n`, url: URLS.linuxX86},
  'Linux aarch64': {input: `cpython-3.12.9-linux-aarch64-gnu   ${URLS.linuxArm}\n`, url: URLS.linuxArm},
  'macOS aarch64': {input: `cpython-3.12.9-macos-aarch64-none  ${URLS.macosArm}\n`, url: URLS.macosArm},
  'macOS x86_64': {input: `cpython-3.12.9-macos-x86_64-none   ${URLS.macosX86}\n`, url: URLS.macosX86},
  'macOS aarch64 under CLICOLOR_FORCE=1': {
    input: `cpython-3.12.9-macos-aarch64-none  ${ESC}[2m${URLS.macosArm}${ESC}[0m\n`,
    url: URLS.macosArm,
  },
  'every field coloured': {
    input: `${ESC}[1mcpython-3.12.9-macos-aarch64-none${ESC}[0m  ${ESC}[2m${URLS.macosArm}${ESC}[0m\n`,
    url: URLS.macosArm,
  },
};

describe('python-download-url.sh', () => {
  for (const [name, sample] of Object.entries(SAMPLES)) {
    test(`prints the download URL: ${name}`, () => {
      assert.equal(parse(sample.input), `${sample.url}\n`);
    });
  }

  test('skips free-threaded builds and entries without a URL', () => {
    const input = [
      `cpython-3.13.2+freethreaded-macos-aarch64-none  ${BASE}/cpython-3.13.2%2B20250317-aarch64-apple-darwin-freethreaded%2Bpgo-full.tar.zst`,
      'cpython-3.12.9-macos-aarch64-none               <download available>',
      `cpython-3.12.9-macos-aarch64-none               ${URLS.macosArm}`,
      '',
    ].join('\n');
    assert.equal(parse(input), `${URLS.macosArm}\n`);
  });

  test('prints nothing when uv lists no download', () => {
    assert.equal(parse(''), '');
    assert.equal(parse('cpython-3.12.9-macos-aarch64-none  /Users/runner/.local/share/uv/python/bin/python3.12\n'), '');
  });

  test('reads all its input, so uv never meets a broken pipe', () => {
    const ran = spawnSync('bash', ['-c', 'set -o pipefail; seq 100000 | sed "s|.*|$LINE|" | bash "$SCRIPT" >/dev/null'], {
      env: {...process.env, LINE: `cpython-3.12.9-macos-aarch64-none  ${URLS.macosArm}`, SCRIPT: path.join(REPO, 'scripts', 'bundle', 'python-download-url.sh')},
      encoding: 'utf8',
    });
    assert.equal(ran.status, 0, ran.stderr);
  });
});

describe('build-bundle.sh: the CPython licence archive', () => {
  const script = fs.readFileSync(path.join(REPO, 'scripts', 'build-bundle.sh'), 'utf8');
  const pins = fs.readFileSync(path.join(REPO, 'scripts', 'bundle', 'python-licenses.sha256'), 'utf8');

  test('asks uv for uncoloured output and parses it with the tested helper', () => {
    assert.match(script, /uv --color never python list "\$1" --only-downloads --show-urls \| bash "\$ROOT\/scripts\/bundle\/python-download-url\.sh"/);
  });

  for (const [name, url] of Object.entries(URLS)) {
    test(`pins the full archive of ${name}`, () => {
      const match = /\/releases\/download\/([0-9]+)\/cpython-[0-9.]+%2B[0-9]+-(.+)-install_only/.exec(url);
      assert.ok(match, 'the URL has the shape build-bundle.sh expects');
      const prefix = `cpython-3.12.9+${match[1]}-${match[2]}-`;
      const pinned = pins.split('\n').filter((line) => line.split(/\s+/)[1]?.startsWith(prefix) && line.endsWith('-full.tar.zst'));
      assert.equal(pinned.length, 1, `one pin for ${prefix}`);
      assert.match(pinned[0] as string, /^[a-f0-9]{64} {2}\S+$/);
    });
  }
});
