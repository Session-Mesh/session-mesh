// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Every workflow under .github/workflows must be loadable by a YAML parser. The tests of the workflow
// profiles read lines, not YAML, so an unquoted value such as
//   PATCH: ${{ contains(labels, 'semver: patch') }}
// ("mapping values are not allowed here") passed them while GitHub could not load the workflow. This
// repository has no YAML parser among its pinned dependencies, so the class of fault that broke
// backport-register.yml is checked directly: a plain (unquoted) value of a block mapping or a list item
// must not hold ": " nor end with ":", which a YAML 1.2 parser reads as a nested mapping.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {parseLines} from './public-ci-workflow-lib.ts';

const WORKFLOWS = path.join(import.meta.dirname, '..', '.github', 'workflows');
// A value that starts a quoted scalar, a flow collection, a block scalar, an anchor, an alias or a tag is
// not a plain scalar.
const NOT_PLAIN = /^(?:["'[{|>&*!])/;

// The lines whose plain value is not loadable, as `line N: text`.
export function plainScalarProblems(text: string): string[] {
  const problems: string[] = [];
  for (const line of parseLines(text)) {
    if (line.inBlock) continue;
    const match = /^\s*(?:-\s+)?(?:[\w.-]+|"[^"]*"|'[^']*'):\s+(\S.*)$/.exec(line.text);
    if (!match || NOT_PLAIN.test(match[1])) continue;
    if (/:(?:\s|$)/.test(match[1])) problems.push(`line ${line.number}: ${line.text.trim().slice(0, 100)}`);
  }
  return problems;
}

describe('the workflows hold no plain value that a YAML parser reads as a nested mapping', () => {
  const files = fs.readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name)).sort();
  assert.ok(files.length > 0);
  for (const name of files) {
    test(name, () => {
      assert.deepEqual(plainScalarProblems(fs.readFileSync(path.join(WORKFLOWS, name), 'utf8')), []);
    });
  }

  test('reports the unquoted value that made backport-register.yml unloadable', () => {
    const broken = "env:\n  PATCH: ${{ contains(github.event.pull_request.labels.*.name, 'semver: patch') }}\n";
    assert.deepEqual(plainScalarProblems(broken), ["line 2: PATCH: ${{ contains(github.event.pull_request.labels.*.name, 'semver: patch') }}"]);
  });

  test('reports the unquoted value under a quoted key and accepts a quoted value under one', () => {
    const quotedKeys = "env:\n  \"PATCH\": ${{ contains(x, 'semver: patch') }}\n  'OTHER': ${{ contains(x, 'semver: patch') }}\n";
    assert.equal(plainScalarProblems(quotedKeys).length, 2);
    assert.deepEqual(plainScalarProblems("env:\n  \"PATCH\": \"${{ contains(x, 'semver: patch') }}\"\n"), []);
  });

  test('accepts the same expression in double quotes, a block scalar and a list item', () => {
    const fine = "env:\n  PATCH: \"${{ contains(x, 'semver: patch') }}\"\n  run: |\n    echo a: b\n  title: a:b\nitems:\n  - name: x\n";
    assert.deepEqual(plainScalarProblems(fine), []);
  });
});
