// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Shared fixtures for the leak-guard tests. Every leaking value is invented and assembled by
// concatenation, so this source never matches the rules it exercises.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(import.meta.dirname, '..');
export const CLI = path.join(REPO, 'tools/leak-guard/cli.ts');
const AT = '@';

export const FAKE = {
  email: 'jane.doe' + AT + 'corp-fake.org',
  agentEmail: 'noreply' + AT + 'agent-fake.ai',
  home: '/ho' + 'me/zed/projects',
  macHome: '/Us' + 'ers/zed/projects',
  tailnetIpv4: '100.' + '101.2.3',
  tailnetIpv6: ['fd7a', '115c', 'a1e0'].join(':') + '::1',
  tailnetHost: 'box.tail' + 'abc123.ts' + '.net',
  privateName: 'Zorblax' + ' Industries',
  privateHost: 'quux' + 'host',
  // Visibly invented: a fixed word followed by zeros, in GitHub's token shape so gitleaks reports it.
  token: 'ghp_' + 'FakeLeakGuardFixture' + '0'.repeat(16),
  noreply: 'tester' + AT + 'users.noreply.github.com',
  tailscaleKey: 'tskey-' + 'auth-' + 'kFake7CNTRL-' + 'Q1w2E3r4T5y6U7i8O9p0Aa',
};

// Variants of the leaks above that the generic rules also recognize.
export const VARIANT = {
  varHome: '/var' + '/ho' + 'me/zed/projects',
  windowsHome: 'C:\\' + 'Users\\zed\\projects',
  windowsHomeEscaped: 'C:\\\\' + 'Users\\\\zed\\\\projects',
  upperTailnetHost: FAKE.tailnetHost.toUpperCase(),
  encodedEmail: 'jane.doe' + '%40' + 'corp-fake.org',
};

export const ALLOWED = {
  noreply: '12345+someone' + AT + 'users.noreply.github.com',
  githubMerge: 'noreply' + AT + 'github.com',
  githubGit: 'git' + AT + 'github.com',
  gitlabGit: 'git' + AT + 'gitlab.com',
  example: 'someone' + AT + 'example.com',
  exampleOrg: 'someone' + AT + 'example.org',
  exampleNet: 'someone' + AT + 'example.net',
  exampleSubdomain: 'someone' + AT + 'mail.example.com',
  exampleTopLevel: 'someone' + AT + 'host.example',
  invalid: 'someone' + AT + 'host.invalid',
  testDomain: 'someone' + AT + 'mail.test',
  localhost: 'someone' + AT + 'box.localhost',
  homeTemplate: '/ho' + 'me/USER/.config',
  homeVariable: '/ho' + 'me/$USER/.config',
  tailnetExample: 'mesh.example.ts' + '.net',
};

// A neutral trailer line used as filler in commit messages.
export const TRAILER = 'Reviewed-by: Example Person';

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `leak-guard-${prefix}-`));
}

export function writePrivateList(directory: string): string {
  const file = path.join(directory, 'private.json');
  const forbidden = [
    {id: 'org', literal: FAKE.privateName, caseInsensitive: true},
    {id: 'host', literal: FAKE.privateHost, caseInsensitive: false},
  ];
  fs.writeFileSync(file, JSON.stringify({schema: 1, forbidden}));
  return file;
}

// Isolated from the user's Git configuration and locale.
export function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...extra};
  delete env.MESH_LEAK_PRIVATE_RULES;
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && key.endsWith('_IDENT')) delete env[key];
  return {...env, ...extra};
}

export function git(cwd: string, args: string[], env = baseEnv()): string {
  const run = spawnSync('git', args, {cwd, env, encoding: 'utf8'});
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

export function tryGit(cwd: string, args: string[], env = baseEnv()) {
  return spawnSync('git', args, {cwd, env, encoding: 'utf8'});
}

export function initRepo(prefix: string): string {
  const root = path.join(tempDir(prefix), 'repo');
  fs.mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Tester']);
  git(root, ['config', 'user.email', FAKE.noreply]);
  return root;
}

export function runCli(cwd: string, args: string[], env = baseEnv()) {
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args], {cwd, env, encoding: 'utf8'});
  return {status: run.status, stdout: run.stdout, stderr: run.stderr, output: run.stdout + run.stderr};
}

export function write(root: string, file: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), content);
}

export function remove(directory: string): void {
  fs.rmSync(directory, {recursive: true, force: true});
}
