// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A session started with an account alias keeps it across a restore: the snapshot records the alias id, the
// conversation is looked for in that alias's Claude folder only, and the agent is relaunched with the
// alias's CLAUDE_CONFIG_DIR. A conversation found only under the default account is never resumed for an
// alias session, and an alias removed from accounts.json refuses the restore instead of falling back to the
// default account. Real server.py and PTY host, fake `claude` (tests/restore-exact-lib.ts).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {REPO} from './mesh-server-lib.ts';
import {SID, withLab} from './restore-exact-lib.ts';

const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'platform', 'cli', 'mesh_platform_main.exe');
// Without mesh-platform (a job that only fetches the PTY host) these are skipped, with the reason, unless
// MESH_REQUIRE_MESH_PLATFORM is set (CI): then a missing program fails them.
const TIMEOUT = {timeout: 120000, skip: fs.existsSync(PLATFORM) || process.env.MESH_REQUIRE_MESH_PLATFORM ? false
  : `mesh-platform not built: dune build ./platform/cli/mesh_platform_main.exe, or set MESH_MESH_PLATFORM_CMD (${PLATFORM})`};
const env = {MESH_MESH_PLATFORM_CMD: PLATFORM, CLAUDE_CONFIG_DIR: undefined};
const workDir = (home: string) => path.join(home, '.agent-accounts', 'work', '.claude');

/** accounts.json with the alias `work` (unless `declared` is false), and its Claude folder holding `projects/`,
 * with the conversation SID in it when `transcript`. */
function prepare(transcript: boolean, declared = true) {
  return (home: string, confDir: string) => {
    const folder = path.join(workDir(home), 'projects', '-elsewhere');
    fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    if (transcript) fs.writeFileSync(path.join(folder, `${SID}.jsonl`), '{}\n');
    const accounts = declared ? [{id: 'work', label: 'Atacama', claude_config_dir: workDir(home)}] : [];
    fs.writeFileSync(path.join(confDir, 'accounts.json'), JSON.stringify({v: 1, accounts}));
  };
}

function newRequests() {
  const sent: Record<string, any> = {};
  return {sent, intercept: (request: any) => { if (request.op === 'new') sent[request.name] = request; return undefined; }};
}

test('a restored alias session resumes its conversation with the alias folder', TIMEOUT, () => {
  const host = newRequests();
  return withLab(async lab => {
    const answer = await lab.post({names: ['alpha']});
    assert.equal(answer.json.results.alpha.resumed, true, answer.text);
    assert.equal(host.sent.alpha.meta.account, 'work');
    // the alias's folder, the default account's credential variables unset (server.ACCOUNT_OVERRIDES)
    assert.ok(host.sent.alpha.command.startsWith('env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN '),
      host.sent.alpha.command);
    assert.ok(host.sent.alpha.command.includes(` CLAUDE_CONFIG_DIR=${workDir(lab.mesh.home)} `), host.sent.alpha.command);
    assert.match(host.sent.alpha.command, new RegExp(`--resume ${SID}`));
  }, {env, alphaExtra: {account: 'work'}, prepare: prepare(true), intercept: host.intercept});
});

test('a conversation only under the default account is not resumed for an alias session', TIMEOUT, () => {
  const host = newRequests();
  return withLab(async lab => {
    const answer = await lab.post({names: ['alpha']});
    assert.equal(answer.json.results.alpha.resumed, false, answer.text);
    assert.match(answer.json.results.alpha.note, /Conversation not found/);
    assert.ok(!host.sent.alpha.command.includes('--resume'), host.sent.alpha.command);
  }, {env, alphaExtra: {account: 'work'}, prepare: prepare(false), intercept: host.intercept});
});

test('an alias removed from accounts.json refuses the restore: never the default account', TIMEOUT, () =>
  withLab(async lab => {
    const answer = await lab.post({names: ['alpha']});
    assert.equal(answer.json.results.alpha.ok, false, answer.text);
    assert.match(answer.json.results.alpha.error, /^Unknown account alias/);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(lab.starts(), 0, 'no agent was started');
  }, {env, alphaExtra: {account: 'work'}, prepare: prepare(true, false)}));
