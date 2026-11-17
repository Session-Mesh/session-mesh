// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// `leak-guard pr-body <file>`: the content rules of a commit message applied to a pull request
// description, without the commit conventions (trailers, agent co-author lines, identities).
import assert from 'node:assert/strict';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {FAKE, REPO, TRAILER, remove, runCli, tempDir, write} from './leak-guard-fixtures.ts';

const scratch = tempDir('pr-body');
after(() => remove(scratch));
const CLEAN = '## What\n\nAdds a retry to the pairing step. Run `scripts/test-local.sh` to check.\n';

function check(body: string, extra: string[] = []) {
  write(scratch, 'body.md', body);
  return runCli(scratch, [...extra, 'pr-body', path.join(scratch, 'body.md')]);
}

describe('pr-body', () => {
  test('a clean body passes', () => {
    const run = check(CLEAN);
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, /0 finding/);
  });

  test('a body with no trailer line passes', () => {
    assert.equal(check(CLEAN).status, 0);
  });

  test('an agent co-author line is not a finding in a description', () => {
    const body = `${CLEAN}\nCo-Authored-By: Some Agent <1+agent${'@'}users.noreply.github.com>\n`;
    assert.equal(check(body).status, 0);
  });

  test('an AI attribution line passes pr-body and message', () => {
    const line = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
    assert.equal(check(`${CLEAN}\n${line}\n`).status, 0);
    write(scratch, 'msg.txt', `fix\n\n${line}\n\n${TRAILER}\n`);
    const run = runCli(scratch, ['message', path.join(scratch, 'msg.txt')]);
    assert.equal(run.status, 0, run.output);
  });

  test('a trailer line is accepted too', () => assert.equal(check(`${CLEAN}\n${TRAILER}\n`).status, 0));

  const leaks: Array<[string, string, string]> = [
    ['home-path', `Ran it from ${FAKE.home}`, FAKE.home],
    ['email', `Contact ${FAKE.email}`, FAKE.email],
    ['tailnet-ipv6', `Seen on ${FAKE.tailnetIpv6}`, FAKE.tailnetIpv6],
    ['tailnet-ipv4', `Seen on ${FAKE.tailnetIpv4}`, FAKE.tailnetIpv4],
    ['tailnet-host', `Seen on ${FAKE.tailnetHost}`, FAKE.tailnetHost],
    ['gitleaks', `token ${FAKE.token}`, FAKE.token],
  ];
  for (const [label, line, secret] of leaks) {
    test(`a body with a ${label} leak fails with exit 1`, () => {
      const run = check(`${CLEAN}\n${line}\n`);
      assert.equal(run.status, 1, run.output);
      assert.match(run.stdout, /^<pr-body>:\d+ /m);
      if (label === 'gitleaks') assert.doesNotMatch(run.output, new RegExp(secret.slice(4, 24)), 'the secret is redacted');
    });
  }

  test('exceptions never apply to a description', () => {
    const entry = {path: 'body.md', rule: 'email', substring: FAKE.email, reason: 'test'};
    write(scratch, 'allow.json', JSON.stringify({schema: 1, exceptions: [entry]}));
    const run = check(`${CLEAN}\n${FAKE.email}\n`, ['--exceptions', path.join(scratch, 'allow.json')]);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /\[message\] email/);
  });

  test('a missing file is a tool error, not a clean result', () => {
    assert.equal(runCli(scratch, ['pr-body', path.join(scratch, 'absent.md')]).status, 2);
  });

  test('the pull request template passes', () => {
    const run = runCli(REPO, ['pr-body', '.github/pull_request_template.md']);
    assert.equal(run.status, 0, run.output);
  });
});
