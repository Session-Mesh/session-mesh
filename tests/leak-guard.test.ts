// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {after, describe, test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {applyExceptions, loadExceptions} from '../tools/leak-guard/exceptions.ts';
import {parseDiff} from '../tools/leak-guard/gitrepo.ts';
import {checkIdentity} from '../tools/leak-guard/identity.ts';
import {checkMessage} from '../tools/leak-guard/message.ts';
import {loadPublicRules, type RuleSet, scanText} from '../tools/leak-guard/rules.ts';
import {scanFile} from '../tools/leak-guard/content.ts';
import {spawnSync} from 'node:child_process';
import {ALLOWED, CLI, FAKE, TRAILER, VARIANT, baseEnv, git, initRepo, remove, runCli, tempDir, write, writePrivateList} from './leak-guard-fixtures.ts';

const scratch = tempDir('unit');
after(() => remove(scratch));
const privateFile = writePrivateList(scratch);
const ruleSet: RuleSet = {
  publicRules: loadPublicRules(),
  privateRules: JSON.parse(fs.readFileSync(privateFile, 'utf8')).forbidden,
  privateSource: privateFile,
};
const rulesIn = (text: string, file = 'src/a.txt') => scanText(ruleSet, {gate: 'content', path: file}, text).map(f => f.rule);

describe('content rules: one negative case per leak class', () => {
  const cases: Array<[string, string]> = [
    ['email', `contact ${FAKE.email} now`],
    ['home-path', `cd ${FAKE.home}`],
    ['home-path', `open ${FAKE.macHome}`],
    ['tailnet-ipv4', `ping ${FAKE.tailnetIpv4}`],
    ['tailnet-ipv6', `addr ${FAKE.tailnetIpv6}`],
    ['tailnet-host', `https://${FAKE.tailnetHost}:8443/`],
    ['private:org', `made by ${FAKE.privateName.toUpperCase()}`],
    ['private:host', `ssh ${FAKE.privateHost}`],
  ];
  for (const [rule, text] of cases) test(`${rule} is reported`, () => assert.deepEqual(rulesIn(text), [rule]));
  test('case-sensitive private literal ignores other cases', () => assert.deepEqual(rulesIn(FAKE.privateHost.toUpperCase()), []));
  test('tailscale-key is reported', () => assert.deepEqual(rulesIn(`TS_AUTHKEY=${FAKE.tailscaleKey}`), ['tailscale-key']));
  test('the word tskey alone passes', () => assert.deepEqual(rulesIn('set the tskey value; tskey-auth keys expire'), []));
});

describe('content rules: generic variants', () => {
  const cases: Array<[string, string]> = [
    ['home-path', `cd ${VARIANT.varHome}`],
    ['home-path', `dir ${VARIANT.windowsHome}`],
    ['home-path', `"path": "${VARIANT.windowsHomeEscaped}"`],
    ['tailnet-host', `https://${VARIANT.upperTailnetHost}/`],
    ['email', `mailto=${VARIANT.encodedEmail}`],
  ];
  for (const [rule, text] of cases) test(`${rule}: ${text}`, () => assert.deepEqual(rulesIn(text), [rule]));
  test('templated variants pass', () => assert.deepEqual(rulesIn('C:\\Users\\USER\\x /var/home/$USER/x'), []));
});

describe('content rules: allowed forms pass', () => {
  for (const [label, text] of Object.entries(ALLOWED)) test(`${label} passes`, () => assert.deepEqual(rulesIn(text), []));
  test('IPv4 outside the tailnet range passes', () => assert.deepEqual(rulesIn('100.' + '63.1.1 and 100.' + '128.1.1'), []));
  test('a path segment named home is not a home directory', () => assert.deepEqual(rulesIn('root/' + 'home/cwd'), []));
  test('static/vendor/ is exempt from email and host rules only', () => {
    const text = `${FAKE.email} ${FAKE.tailnetHost} ${FAKE.home}`;
    assert.deepEqual(rulesIn(text, 'static/vendor/lib.js'), ['home-path']);
  });
});

test('excerpts are bounded', () => {
  const [finding] = scanText(ruleSet, {gate: 'content', path: 'a'}, 'x '.repeat(300) + FAKE.email + ' y'.repeat(300));
  assert.ok(finding.excerpt.length < 140, finding.excerpt);
  assert.ok(finding.excerpt.includes(FAKE.email));
});

test('binary files are read byte for byte', () => {
  const bytes = Buffer.concat([Buffer.from([0x89, 0, 1, 2]), Buffer.from(FAKE.email, 'latin1'), Buffer.from([0, 255])]);
  assert.deepEqual(scanFile(ruleSet, 'static/icons/x.png', bytes).map(f => f.rule), ['email']);
});

test('UTF-16 text in either byte order is read', () => {
  const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`x ${FAKE.email}\n`, 'utf16le')]);
  const big = Buffer.from(little.subarray(2).toString('utf16le'), 'utf16le').swap16();
  assert.deepEqual(scanFile(ruleSet, 'doc.txt', little).map(f => f.rule), ['email']);
  assert.deepEqual(scanFile(ruleSet, 'doc.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), big])).map(f => f.rule), ['email']);
});

test('file names are a gate', () => {
  const findings = scanFile(ruleSet, `notes/${FAKE.privateHost}-setup.md`, Buffer.from('clean'));
  assert.deepEqual(findings.map(f => [f.gate, f.rule]), [['filename', 'private:host']]);
});

describe('message gate', () => {
  const rules = (message: string) => checkMessage(ruleSet, '<m>', message).map(f => f.rule).sort();
  test('an agent co-author line passes (only its content is checked)', () => {
    assert.deepEqual(rules(`fix\n\n${TRAILER}\nCo-Authored-By: Claude Opus <${FAKE.agentEmail}>\n`), ['email']);
  });
  test('agent co-author name with a noreply address passes', () => {
    assert.deepEqual(rules(`fix\n\n${TRAILER}\nCo-authored-by: Codex <${ALLOWED.noreply}>\n`), []);
  });
  test('agent session trailer is refused', () => {
    assert.deepEqual(rules(`fix\n\n${TRAILER}\nClaude-Session: https://example.com/s/1\n`), ['agent-session-trailer']);
  });
  test('a message without any trailer passes', () => assert.deepEqual(rules('fix\n'), []));
  test('private and generic content in the message is refused', () => {
    assert.deepEqual(rules(`deploy to ${FAKE.privateHost}\n\n${TRAILER}\n`), ['private:host']);
  });
  test('human noreply co-author and Harness trailers pass', () => {
    const message = `fix\n\n${TRAILER}\nCo-authored-by: Some One <${ALLOWED.noreply}>\nHarness-Mode: fast\n`;
    assert.deepEqual(rules(message), []);
  });
});

describe('message gate: lines git keeps are checked (B1)', () => {
  const CUT = '# ------------------------ >8 ------------------------';
  const rules = (message: string, source: 'recorded' | 'hook' = 'recorded') =>
    checkMessage(ruleSet, '<m>', message, source).map(f => f.rule).sort();
  test('a recorded comment line is checked', () => assert.deepEqual(rules(`fix\n\n# ${FAKE.privateHost}\n\n${TRAILER}\n`), ['private:host']));
  test('recorded text below a scissors line is checked', () => {
    assert.deepEqual(rules(`fix\n\n${TRAILER}\n${CUT}\n+${FAKE.email}\n`), ['email']);
  });
  test('the hook checks comment lines, which git commit -m and -F keep', () => {
    assert.deepEqual(rules(`fix\n\n${TRAILER}\n# ${FAKE.email}\n`, 'hook'), ['email']);
  });
  test('the hook checks text below a bare scissors line', () => {
    assert.deepEqual(rules(`fix\n\n${TRAILER}\n${CUT}\n${FAKE.email}\n`, 'hook'), ['email']);
  });
  test('the hook skips what follows git\'s own cut line and notice when it is the diff', () => {
    const message = `fix\n\n${TRAILER}\n${CUT}\n# Do not modify or remove the line above.\n# Everything below it will be ignored.\ndiff --git a/x b/x\n+${FAKE.email}\n`;
    assert.deepEqual(rules(message, 'hook'), []);
  });
  test('comment lines after the trailers do not matter', () => {
    assert.deepEqual(rules(`fix\n\n${TRAILER}\n#\n# template\n`, 'hook'), []);
  });
});

describe('message gate: agent lines and the final trailer block', () => {
  const rules = (message: string) => checkMessage(ruleSet, '<m>', message).map(f => f.rule).sort();
  const agentCases: Array<[string, string]> = [
    ['camelCase agent name', `Co-authored-by: ClaudeCode <${ALLOWED.noreply}>`],
    ['indented trailer', `  Co-Authored-By: Codex <${ALLOWED.noreply}>`],
    ['key with a space', `Co-authored by: Copilot <${ALLOWED.noreply}>`],
  ];
  for (const [label, line] of agentCases) {
    // In the body, so that a line git would not parse as a trailer leaves the final block intact.
    test(`agent co-author passes: ${label}`, () => assert.deepEqual(rules(`fix\n\n${line}\n\n${TRAILER}\n`), []));
  }
  test('an AI attribution line passes the commit-msg hook', () => {
    const message = `fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${TRAILER}\n`;
    assert.deepEqual(rules(message), []);
    assert.deepEqual(rules(`fix\n\n${TRAILER}\nAssisted-by: Gemini\nGenerated-by: ClaudeCode\n`), []);
  });
  test('a session trailer is still refused', () => {
    assert.deepEqual(rules(`fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${TRAILER}\nClaude-Session: abc123\n`), ['agent-session-trailer']);
  });
  test('a human whose name contains an agent name as a fragment passes', () => {
    assert.deepEqual(rules(`fix\n\n${TRAILER}\nCo-authored-by: Zaider Devinsworth <${ALLOWED.noreply}>\n`), []);
  });
});

describe('identity gate', () => {
  const rules = (role: 'author' | 'committer', name: string, address: string) => checkIdentity(ruleSet, role, name, address).map(f => f.rule);
  test('non-noreply author is refused', () => assert.deepEqual(rules('author', 'Jane', FAKE.email), ['identity-not-noreply']));
  test('private name in the identity is refused', () => assert.deepEqual(rules('author', FAKE.privateName, ALLOWED.noreply), ['private:org']));
  test('noreply author passes', () => assert.deepEqual(rules('author', 'Someone', ALLOWED.noreply), []));
  test('generic rules apply to the name', () => {
    assert.deepEqual(rules('author', `Jane ${FAKE.email}`, ALLOWED.noreply), ['email']);
    assert.deepEqual(rules('committer', `build ${FAKE.tailnetHost}`, ALLOWED.noreply), ['tailnet-host']);
  });
  test('GitHub merge committer passes only as committer', () => {
    assert.deepEqual(rules('committer', 'GitHub', ALLOWED.githubMerge), []);
    assert.deepEqual(rules('author', 'GitHub', ALLOWED.githubMerge), ['identity-not-noreply']);
  });
});

describe('exceptions', () => {
  const finding = {gate: 'content' as const, path: 'docs/a.md', line: 3, rule: 'email', excerpt: `mail ${FAKE.email}`, match: FAKE.email};
  const exception = {path: 'docs/a.md', rule: 'email', substring: FAKE.email, reason: 'test'};
  test('a matching exception removes the finding', () => assert.deepEqual(applyExceptions([finding], [exception], true), []));
  test('an exception covers the matched value only, not its neighbours in the excerpt', () => {
    const other = {...finding, excerpt: `${FAKE.email} ${ALLOWED.example}`, match: 'other' + FAKE.email};
    assert.deepEqual(applyExceptions([other], [exception], false), [other]);
  });
  test('an exception never covers a message or an identity finding', () => {
    const message = {...finding, gate: 'message' as const};
    const identity = {...finding, gate: 'identity' as const};
    assert.deepEqual(applyExceptions([message, identity], [exception], false), [message, identity]);
  });
  test('a stale exception fails full scans', () => {
    assert.deepEqual(applyExceptions([], [exception], true).map(f => f.rule), ['stale-exception']);
    assert.deepEqual(applyExceptions([], [exception], false), []);
  });
  for (const rule of ['secret', 'private:org']) {
    test(`${rule} exceptions are rejected`, () => {
      const file = path.join(scratch, `exceptions-${rule.replace(':', '-')}.json`);
      fs.writeFileSync(file, JSON.stringify({schema: 1, exceptions: [{...exception, rule}]}));
      assert.throws(() => loadExceptions(file));
    });
  }
  test('the repository exception file loads', () => assert.ok(Array.isArray(loadExceptions())));
});

test('diff parser keeps added lines, line numbers and new-file flags', () => {
  const patch = ['diff --git a/n.txt b/n.txt', 'new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@',
    '+one', '++++ looks like a header', 'diff --git a/o.txt b/o.txt', '--- a/o.txt', '+++ b/o.txt', '@@ -4,0 +5 @@', '+five'].join('\n');
  assert.deepEqual(parseDiff(patch).map(c => [c.path, c.isNew, c.lines, c.lineNumbers]),
    [['n.txt', true, ['one', '+++ looks like a header'], [1, 2]], ['o.txt', false, ['five'], [5]]]);
});

describe('command line', () => {
  const env = baseEnv({MESH_LEAK_PRIVATE_RULES: privateFile});
  test('tree reports content, names and per-rule counts; exit 1', () => {
    const dir = tempDir('tree');
    write(dir, 'a.txt', `x ${FAKE.email}\n`);
    write(dir, `${FAKE.privateHost}.md`, 'clean\n');
    const run = runCli(dir, ['--no-secrets', 'tree', '.'], env);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /a\.txt:1 {2}\[content\] email/);
    assert.match(run.stdout, /\[filename\] private:host/);
    assert.match(run.stdout, /^ +1 {2}email$/m);
    remove(dir);
  });
  test('without a private list the tool says so and applies generic rules', () => {
    const dir = tempDir('noprivate');
    write(dir, 'a.txt', `${FAKE.privateHost}\n`);
    const run = runCli(dir, ['--no-secrets', 'tree', '.']);
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, /warning: no private list/);
    remove(dir);
  });
  test('an unreadable private list is a tool error (2)', () => {
    assert.equal(runCli(scratch, ['--private', path.join(scratch, 'missing.json'), 'identity', 'a', ALLOWED.noreply]).status, 2);
  });
  test('message and identity commands', () => {
    const file = path.join(scratch, 'msg.txt');
    fs.writeFileSync(file, 'fix\n');
    assert.equal(runCli(scratch, ['--no-secrets', 'message', file], env).status, 0);
    fs.writeFileSync(file, `fix ${FAKE.privateHost}\n`);
    assert.equal(runCli(scratch, ['--no-secrets', 'message', file], env).status, 1);
    fs.writeFileSync(file, `fix\n\n${TRAILER}\n`);
    assert.equal(runCli(scratch, ['--no-secrets', 'message', file], env).status, 0);
    assert.equal(runCli(scratch, ['identity', 'Jane', FAKE.email], env).status, 1);
    assert.equal(runCli(scratch, ['identity', 'Jane', ALLOWED.noreply], env).status, 0);
  });
  test('worktree, staged and commits gates in a repository', () => {
    const root = initRepo('cli');
    write(root, 'old.txt', `${FAKE.email}\n`);
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '--no-verify', '-m', `seed\n\n${TRAILER}`]);
    const base = git(root, ['rev-parse', 'HEAD']).trim();
    assert.equal(runCli(root, ['--no-secrets', 'worktree'], env).status, 1, 'committed leak is in the worktree');
    write(root, 'old.txt', `${FAKE.email}\nclean line\n`);
    git(root, ['add', '.']);
    assert.equal(runCli(root, ['--no-secrets', 'staged'], env).status, 0, 'pre-existing lines are not re-reported');
    write(root, 'new.txt', `${FAKE.tailnetIpv4}\n`);
    git(root, ['add', '.']);
    assert.match(runCli(root, ['--no-secrets', 'staged'], env).stdout, /new\.txt:1 {2}\[content\] tailnet-ipv4/);
    git(root, ['commit', '-q', '--no-verify', '-m', 'no trailer']);
    const run = runCli(root, ['--no-secrets', 'commits', `${base}..HEAD`], env);
    assert.equal(run.status, 1);
    assert.doesNotMatch(run.stdout, /:<message>/);
    assert.match(run.stdout, /:new\.txt:1 {2}\[content\] tailnet-ipv4/);
    assert.doesNotMatch(run.stdout, /old\.txt:1/);
    remove(path.dirname(root));
  });
  test('commits checks comment lines and text below a scissors line that git commit -m kept (B1)', () => {
    const root = initRepo('b1');
    const cut = '# ------------------------ >8 ------------------------';
    git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `a\n\n# ${FAKE.privateHost}\n\n${TRAILER}`]);
    git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `b\n\n${TRAILER}\n${cut}\n${FAKE.email}`]);
    assert.match(git(root, ['log', '-1', '--format=%B']), new RegExp(FAKE.email.replace(/\./g, '\\.')), 'git kept the line');
    const run = runCli(root, ['--no-secrets', 'commits', 'HEAD'], env);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /:<message>:3 {2}\[message\] private:host/);
    assert.match(run.stdout, /:<message>:5 {2}\[message\] email/);
    remove(path.dirname(root));
  });
  test('tree and worktree check the target of a symbolic link (B3)', () => {
    const root = initRepo('b3');
    fs.symlinkSync(FAKE.home, path.join(root, 'link'));
    fs.symlinkSync(`../${FAKE.privateHost}/x`, path.join(root, 'rel'));
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '--no-verify', '-m', `links\n\n${TRAILER}`]);
    for (const args of [['tree', '.'], ['worktree']]) {
      const run = runCli(root, ['--no-secrets', ...args], env);
      assert.equal(run.status, 1, run.output);
      assert.match(run.stdout, /^link:1 {2}\[content\] home-path/m);
      assert.match(run.stdout, /^rel:1 {2}\[content\] private:host/m);
    }
    assert.match(runCli(root, ['--no-secrets', 'commits', 'HEAD'], env).stdout, /:link:1 {2}\[content\] home-path/);
    remove(path.dirname(root));
  });
  test('commits gate checks author and committer identities', () => {
    const root = initRepo('ident');
    git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `a\n\n${TRAILER}`]);
    const idEnv = baseEnv({MESH_LEAK_PRIVATE_RULES: privateFile, GIT_AUTHOR_EMAIL: FAKE.email});
    git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `b\n\n${TRAILER}`], idEnv);
    const run = runCli(root, ['--no-secrets', 'commits', 'HEAD~1..HEAD'], env);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /:<author> {2}\[identity\] identity-not-noreply/);
    assert.doesNotMatch(run.stdout, /<committer>/);
    remove(path.dirname(root));
  });
});

describe('secrets through gitleaks', () => {
  const haveGitleaks = !runCli(scratch, ['message', '/dev/null']).output.includes('gitleaks not found');
  const tokenLine = `token = "${FAKE.token}"\n`;
  test('a token in a tree is reported as secret, redacted', {skip: !haveGitleaks && 'gitleaks is not installed: secret scanning tests skipped'}, () => {
    const dir = tempDir('secret');
    write(dir, 'conf.env', tokenLine);
    const run = runCli(dir, ['tree', '.']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /conf\.env:1 {2}\[content\] secret {2}github-pat: REDACTED/);
    assert.ok(!run.stdout.includes(FAKE.token));
    remove(dir);
  });
  test('a staged token and a committed token are reported', {skip: !haveGitleaks && 'gitleaks is not installed: secret scanning tests skipped'}, () => {
    const root = initRepo('secret');
    git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `a\n\n${TRAILER}`]);
    write(root, 'conf.env', tokenLine);
    git(root, ['add', '.']);
    assert.match(runCli(root, ['staged']).stdout, /\] secret {2}github-pat/);
    git(root, ['commit', '-q', '--no-verify', '-m', `b\n\n${TRAILER}`]);
    assert.match(runCli(root, ['commits', 'HEAD~1..HEAD']).stdout, /:conf\.env:1 {2}\[content\] secret/);
    remove(path.dirname(root));
  });
  test('commits passes every message of the range to gitleaks (B2)', {skip: !haveGitleaks && 'gitleaks is not installed: secret scanning tests skipped'}, () => {
    const root = initRepo('b2');
    git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `a\n\n${TRAILER}`]);
    git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `b\n\n${tokenLine}\n${TRAILER}`]);
    git(root, ['commit', '-q', '--allow-empty', '--no-verify', '-m', `c\n\n${TRAILER}`]);
    const run = runCli(root, ['commits', 'HEAD~2..HEAD']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /:<message>:3 {2}\[content\] secret {2}github-pat/);
    assert.ok(!run.stdout.includes(FAKE.token));
    remove(path.dirname(root));
  });
  test('in-tree gitleaks settings and allow comments do not silence it', {skip: !haveGitleaks && 'gitleaks is not installed: secret scanning tests skipped'}, () => {
    const dir = tempDir('settings');
    write(dir, 'conf.env', tokenLine);
    write(dir, 'other.env', `token = "${FAKE.token}" # gitleaks:allow\n`);
    write(dir, '.gitleaks.toml', '[allowlist]\npaths = [".*"]\n');
    write(dir, '.gitleaksignore', 'conf.env:github-pat:1\n');
    const run = runCli(dir, ['tree', '.']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /other\.env:1 {2}\[content\] secret/, 'gitleaks:allow is ignored');
    assert.match(run.stdout, /warning: \.gitleaks\.toml found in the scanned tree and ignored/);
    // gitleaks always applies an in-tree .gitleaksignore, so the file itself is reported.
    assert.match(run.stdout, /^\.gitleaksignore {2}\[content\] gitleaks-ignore-file/m);
    fs.rmSync(path.join(dir, '.gitleaksignore'));
    assert.match(runCli(dir, ['tree', '.']).stdout, /conf\.env:1 {2}\[content\] secret/, '.gitleaks.toml allowlist is ignored');
    remove(dir);
  });
  test('without gitleaks the report warns that secrets were not checked', () => {
    const dir = tempDir('nogitleaks');
    write(dir, 'conf.env', tokenLine);
    const run = runCli(dir, ['tree', '.'], baseEnv({MESH_LEAK_GITLEAKS: path.join(dir, 'missing-gitleaks')}));
    assert.equal(run.status, 0, run.output);
    assert.match(run.stdout, /warning: gitleaks not found .*secrets were NOT checked/);
    remove(dir);
  });
});

describe('follow-up review fixes (R1, R2, R4, R8)', () => {
  const CUT = '# ------------------------ >8 ------------------------';
  const NOTICE = '# Do not modify or remove the line above.\n# Everything below it will be ignored.';
  const hookRules = (message: string) => checkMessage(ruleSet, '<m>', message, 'hook').map(f => f.rule).sort();
  const haveGitleaks = !runCli(scratch, ['message', '/dev/null']).output.includes('gitleaks not found');

  test('R1: a notice followed by something other than the diff is checked', () => {
    assert.deepEqual(hookRules(`fix\n\n${TRAILER}\n${CUT}\n${NOTICE}\nnotes ${FAKE.email}\n`), ['email']);
  });
  test('R1: a notice followed by nothing, or by blank lines, is skipped', () => {
    assert.deepEqual(hookRules(`fix\n\n${TRAILER}\n${CUT}\n${NOTICE}\n`), []);
    assert.deepEqual(hookRules(`fix\n\n${TRAILER}\n${CUT}\n${NOTICE}\n\n\n`), []);
  });
  test('R1: a leak after the diff header is skipped, one before it is checked', () => {
    assert.deepEqual(hookRules(`fix\n\n${TRAILER}\n${CUT}\n${NOTICE}\n\ndiff --git a/x b/x\n+${FAKE.email}\n`), []);
  });

  const keyRules = (text: string) => scanText(ruleSet, {gate: 'content', path: 'a.txt'}, text);
  for (const kind of ['scim', 'webhook', 'Auth', 'API']) {
    test(`R4: a tskey-${kind} key is reported, in any case`, () => {
      const key = 'tskey-' + kind + '-kFake7CNTRL-' + 'Q1w2E3r4T5y6U7i8O9p0Aa';
      assert.deepEqual(keyRules(`k=${key}`).map(f => f.rule), ['tailscale-key']);
    });
  }
  test('R4: the report excerpt does not show the key value', () => {
    const [finding] = keyRules(`TS_AUTHKEY=${FAKE.tailscaleKey} # note`);
    assert.ok(finding);
    assert.doesNotMatch(finding.excerpt, /kFake7CNTRL|Q1w2E3r4/);
    assert.match(finding.excerpt, new RegExp('tskey-' + 'auth-REDACTED'));
    assert.match(finding.excerpt, /TS_AUTHKEY=/);
  });

  const KEY_A = FAKE.tailscaleKey;
  const KEY_B = 'tskey-' + 'api-' + 'kOther9CNTRL-' + 'Z9y8X7w6V5u4T3s2R1q0Pp';
  const RAW_VALUES = /kFake7CNTRL|Q1w2E3r4|kOther9CNTRL|Z9y8X7w6/;
  test('masking: two keys on one line are both masked', () => {
    const findings = keyRules(`a=${KEY_A} b=${KEY_B}`);
    assert.equal(findings.length, 2);
    for (const finding of findings) assert.doesNotMatch(finding.excerpt, RAW_VALUES);
    assert.match(findings[1]?.excerpt ?? '', new RegExp('b=tskey-' + 'api-REDACTED'));
  });
  test('masking: a key beside an e-mail address is masked in the e-mail finding', () => {
    const findings = keyRules(`mail ${FAKE.email} key ${KEY_A}`);
    assert.deepEqual(findings.map(f => f.rule).sort(), ['email', 'tailscale-key']);
    for (const finding of findings) assert.doesNotMatch(finding.excerpt, RAW_VALUES);
    assert.match(findings.find(f => f.rule === 'email')?.excerpt ?? '', new RegExp(FAKE.email.replace('.', '\\.')));
  });
  test('masking: a key in a message line that triggers a session-trailer finding is masked', () => {
    const message = `fix\n\n${TRAILER}\nClaude-Session: ${KEY_A}\n`;
    const findings = checkMessage(ruleSet, '<m>', message);
    assert.ok(findings.some(f => f.rule === 'agent-session-trailer'));
    for (const finding of findings) assert.doesNotMatch(finding.excerpt, RAW_VALUES);
  });
  test('masking: an identity name carrying a key is masked', () => {
    for (const finding of checkIdentity(ruleSet, 'author', `Zed ${KEY_A}`, 'x' + '@corp-fake.org')) assert.doesNotMatch(finding.excerpt, RAW_VALUES);
  });
  test('R4: the older untyped key form is reported; the word alone and short values pass', () => {
    const legacy = 'tskey-' + 'k1B2c3D4e5F6g7H8i9J0';
    assert.deepEqual(keyRules(`k=${legacy}`).map(f => f.rule), ['tailscale-key']);
    assert.doesNotMatch(keyRules(`k=${legacy}`)[0]?.excerpt ?? '', /k1B2c3D4/);
    assert.deepEqual(keyRules('a tskey-short value; the tskey- prefix; tskey').map(f => f.rule), []);
  });


  test('R2: a .gitleaksignore in the current directory does not silence a message secret', {skip: !haveGitleaks && 'gitleaks is not installed: secret scanning tests skipped'}, () => {
    const dir = tempDir('r2');
    write(dir, '.gitleaksignore', ':github-pat:2\n');
    write(dir, 'msg.txt', `fix\ntoken = "${FAKE.token}"\n\n${TRAILER}\n`);
    const run = runCli(dir, ['message', 'msg.txt']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.stdout, /<message>:2 {2}\[content\] secret/);
    remove(dir);
  });

  test('R8: a closed output ends the tool without a stack trace', () => {
    const root = initRepo('r8');
    write(root, 'many.txt', `${`contact ${FAKE.email}\n`.repeat(3000)}`);
    const command = `node --experimental-strip-types --no-warnings ${JSON.stringify(CLI)} --no-secrets tree . | head -n 1 >/dev/null; echo "status=\${PIPESTATUS[0]}"`;
    const run = spawnSync('bash', ['-c', command, 'bash'], {cwd: root, env: baseEnv(), encoding: 'utf8'});
    assert.doesNotMatch(run.stderr, /EPIPE|at .*\.ts/);
    assert.match(run.stdout, /status=1/);
    remove(path.dirname(root));
  });

  test('masking: a key glued after an underscore is found and masked', () => {
    const findings = keyRules(`KEY_${KEY_A}`);
    assert.deepEqual(findings.map(f => f.rule), ['tailscale-key']);
    assert.doesNotMatch(findings[0]?.excerpt ?? '', RAW_VALUES);
  });
  test('masking: a key in a file or directory name never reaches any output', () => {
    const root = initRepo('keyname');
    const env = baseEnv({MESH_LEAK_PRIVATE_RULES: privateFile});
    write(root, `conf-${KEY_A}.txt`, `contact ${FAKE.email}\n`);
    git(root, ['add', '.']);
    git(root, ['commit', '-q', '--no-verify', '-m', `seed\n\n${TRAILER}`]);
    const base = git(root, ['rev-list', '--max-parents=0', 'HEAD']).trim();
    write(root, `d-${KEY_A}/new-${KEY_A}.txt`, `contact ${FAKE.email}\n`);
    git(root, ['add', '.']);
    const runs = {
      worktree: runCli(root, ['--no-secrets', 'worktree'], env),
      staged: runCli(root, ['--no-secrets', 'staged'], env),
      hook: runCli(root, ['--no-secrets', 'hook', 'pre-commit'], env),
      tree: runCli(root, ['--no-secrets', 'tree', `d-${KEY_A}`], env),
      missing: runCli(root, ['--no-secrets', 'tree', `gone-${KEY_A}`], env),
      commits: runCli(root, ['--no-secrets', 'commits', base], env),
    };
    git(root, ['commit', '-q', '--no-verify', '-m', `more\n\n${TRAILER}`]);
    const range = runCli(root, ['--no-secrets', 'commits', `${base}..HEAD`], env);
    for (const [name, run] of Object.entries({...runs, range})) {
      assert.doesNotMatch(run.output, RAW_VALUES, name);
      assert.equal(run.status, name === 'missing' ? 2 : 1, `${name}: ${run.output}`);
    }
    const masked = 'tskey' + '-auth-REDACTED\\.txt';
    assert.match(runs.worktree.stdout, new RegExp(`conf-${masked} {2}\\[filename\\] tailscale-key`));
    assert.match(runs.worktree.stdout, new RegExp(`conf-${masked}:1 {2}\\[content\\] email`));
    assert.match(range.stdout, new RegExp(`new-${masked}:1 {2}\\[content\\] email`));
    remove(path.dirname(root));
  });
});
