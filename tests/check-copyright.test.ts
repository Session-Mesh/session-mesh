// scripts/check-copyright.sh on throwaway Git repositories: a missing header fails, --fix repairs it,
// the shebang stays first, and an excluded third-party file is never touched.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, test} from 'node:test';

const CHECKER = path.resolve(import.meta.dirname, '..', 'scripts', 'check-copyright.sh');
const SPDX = 'SPDX-License-Identifier: AGPL-3.0-or-later';
const COPYRIGHT = 'Copyright (c) 2026 Atacama <contact@atacama.tech>';
const dirs: string[] = [];

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });

function git(cwd: string, ...args: string[]): void {
  const done = spawnSync('git', args, {cwd, encoding: 'utf8'});
  assert.equal(done.status, 0, done.stderr);
}

// A repository holding `files` (path to text), the exclusion list and the given extra tracked files.
function repoWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-copyright-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'scripts', 'copyright-exclude.txt'), '# test list\nstatic/vendor/*\n');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive: true});
    fs.writeFileSync(path.join(dir, name), text);
  }
  git(dir, 'add', '-A');
  return dir;
}

function run(cwd: string, ...args: string[]) {
  return spawnSync('bash', [CHECKER, ...args], {cwd, encoding: 'utf8'});
}

const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), 'utf8');

describe('scripts/check-copyright.sh', () => {
  test('fails and lists a source file without the header', () => {
    const dir = repoWith({'a.ts': 'export const a = 1;\n', 'ok.ts': `// ${SPDX}\n// ${COPYRIGHT}\n\nexport {};\n`});
    const done = run(dir);
    assert.equal(done.status, 1);
    assert.match(done.stderr, /a\.ts/);
    assert.doesNotMatch(done.stderr, /ok\.ts/);
  });

  test('--fix inserts the header, then the check passes', () => {
    const dir = repoWith({
      'a.ts': 'export const a = 1;\n',
      'lib.ml': 'let x = 1\n',
      'tool.py': '"""Doc."""\nprint(1)\n',
      'page.css': 'body { color: red; }\n',
      'page.html': '<!doctype html>\n<html></html>\n',
    });
    assert.equal(run(dir, '--fix').status, 0);
    assert.equal(run(dir).status, 0);
    assert.equal(read(dir, 'a.ts'), `// ${SPDX}\n// ${COPYRIGHT}\n\nexport const a = 1;\n`);
    const ml = read(dir, 'lib.ml').split('\n');
    assert.equal(ml[0], '(' + '*'.repeat(78) + ')');
    assert.equal(ml[2], `(* ${SPDX.padEnd(74)} *)`);
    assert.equal(ml[3], `(* ${COPYRIGHT.padEnd(74)} *)`);
    assert.ok(ml.every((line) => line.length <= 80));
    assert.equal(ml[6], '');
    assert.equal(ml[7], 'let x = 1');
    assert.match(read(dir, 'tool.py'), new RegExp(`^# ${SPDX}\\n# ${COPYRIGHT.replace(/[()]/g, '\\$&')}\\n\\n"""Doc\\."""`));
    assert.match(read(dir, 'page.css'), /^\/\*\n \* SPDX/);
    assert.match(read(dir, 'page.html'), /^<!doctype html>\n<!--\n {2}SPDX/);
  });

  test('--fix keeps a shebang (and a Python encoding line) first', () => {
    const dir = repoWith({
      'run.sh': '#!/usr/bin/env bash\necho hi\n',
      'tool.py': '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nprint(1)\n',
      'cli.mjs': '#!/usr/bin/env node\n\nconsole.log(1);\n',
      'bin/mesh-x': '#!/bin/sh\necho x\n',
    });
    fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
    assert.equal(run(dir, '--fix').status, 0);
    assert.equal(read(dir, 'run.sh'), `#!/usr/bin/env bash\n# ${SPDX}\n# ${COPYRIGHT}\n\necho hi\n`);
    assert.equal(fs.statSync(path.join(dir, 'run.sh')).mode & 0o777, 0o755);
    assert.equal(read(dir, 'tool.py').split('\n').slice(0, 3).join('\n'), '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n# ' + SPDX);
    assert.equal(read(dir, 'cli.mjs'), `#!/usr/bin/env node\n// ${SPDX}\n// ${COPYRIGHT}\n\nconsole.log(1);\n`);
    assert.equal(read(dir, 'bin/mesh-x').split('\n')[0], '#!/bin/sh');
    assert.equal(run(dir).status, 0);
  });

  test('never reads or modifies an excluded third-party file', () => {
    const vendor = '/*! third-party library */\nvar x=1;\n';
    const dir = repoWith({'static/vendor/lib.min.js': vendor, 'a.ts': 'export {};\n'});
    assert.equal(run(dir, '--fix').status, 0);
    assert.equal(read(dir, 'static/vendor/lib.min.js'), vendor);
    assert.equal(run(dir, 'static/vendor/lib.min.js').status, 0);
  });

  test('is idempotent and leaves non-source files alone', () => {
    const dir = repoWith({'a.ts': 'export {};\n', 'notes.md': '# notes\n', 'data.json': '{}\n'});
    assert.equal(run(dir, '--fix').status, 0);
    const once = read(dir, 'a.ts');
    assert.equal(run(dir, '--fix').status, 0);
    assert.equal(read(dir, 'a.ts'), once);
    assert.equal(read(dir, 'notes.md'), '# notes\n');
    assert.equal(read(dir, 'data.json'), '{}\n');
  });

  test('refuses a different license header instead of rewriting it', () => {
    const dir = repoWith({'a.ts': '// SPDX-License-Identifier: MIT\n// Copyright (c) 2020 Somebody\n\nexport {};\n'});
    const done = run(dir, '--fix');
    assert.equal(done.status, 1);
    assert.match(done.stderr, /a\.ts.*by hand/);
    assert.match(read(dir, 'a.ts'), /MIT/);
  });

  test('--staged checks only the staged files', () => {
    const dir = repoWith({'old.ts': 'export {};\n'});
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
    fs.writeFileSync(path.join(dir, 'new.ts'), 'export {};\n');
    assert.equal(run(dir, '--staged').status, 0);
    git(dir, 'add', 'new.ts');
    const done = run(dir, '--staged');
    assert.equal(done.status, 1);
    assert.match(done.stderr, /new\.ts/);
    assert.doesNotMatch(done.stderr, /old\.ts/);
  });
});
