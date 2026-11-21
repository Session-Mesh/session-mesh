// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {REPO} from './mesh-server-lib.ts';
import {ALPHA_CREATED, SID, withLab} from './restore-exact-lib.ts';

const helper = path.join(REPO, 'ocaml/_build/default/bin/mesh_artifacts_main.exe');
const platform = process.env.MESH_MESH_PLATFORM_CMD || path.join(REPO, 'ocaml/_build/default/platform/cli/mesh_platform_main.exe');
const required = process.env.MESH_REQUIRE_ARTIFACTS || process.env.MESH_REQUIRE_MESH_PLATFORM;
const skip = fs.existsSync(helper) && fs.existsSync(platform) || required ? false : 'built artifact helper and mesh-platform required';

for (const mode of ['ordinary', 'exact']) test(`account alias and artifact continuity coexist on ${mode} restore without grant transfer`, {skip, timeout: 45000}, async () => {
  assert.ok(fs.existsSync(helper) && fs.existsSync(platform));
  const sent: Record<string, any>[] = [];
  const reference = {connector: 'notes', id: 'synthetic-account-reference', kind: 'note', title: 'Alias artifact',
    url: 'https://example.invalid/s/fixture', availability: 'observed-present', created_at: 1, updated_at: 1};
  let originalGrant = '';
  await withLab(async lab => {
    const result = mode === 'ordinary' ? (await lab.post({names: ['alpha']})).json.results.alpha : (await lab.exact(lab.offers.alpha)).json;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.resumed, true);
    assert.equal(sent.length, 1, 'one creation, not a fallback under the default account');
    assert.equal(sent[0]!.meta.account, 'work');
    assert.match(sent[0]!.command, /CLAUDE_CONFIG_DIR=.*--resume/);
    const live = (await lab.listed()).find(row => row.name === 'alpha') as any;
    assert.ok(live && live.created !== ALPHA_CREATED && live.meta.nonce);
    const state = JSON.parse(fs.readFileSync(path.join(lab.mesh.confDir, 'session-artifacts.json'), 'utf8'));
    const target = state.sessions.find((row: any) => row.session.name === 'alpha' && row.session.created === live.created);
    assert.ok(target);
    assert.equal(target.references[0].id, reference.id);
    assert.deepEqual(target.restored_from, {name: 'alpha', created: ALPHA_CREATED});
    assert.equal(state.sessions.some((row: any) => row.session.name === 'alpha' && row.session.created === ALPHA_CREATED), false);
    assert.equal(fs.readFileSync(path.join(lab.mesh.confDir, 'notes-grants.json'), 'utf8'), originalGrant);
    const grant = JSON.parse(execFileSync(helper, [], {input: JSON.stringify({op: 'notes-authorize', session: {name: 'alpha', created: live.created}, nonce: live.meta.nonce, tool: 'mint_share'}) + '\n',
      encoding: 'utf8', env: {PATH: process.env.PATH, HOME: lab.mesh.home, MESH_CONF_DIR: lab.mesh.confDir}}));
    assert.equal(grant.allowed, false, 'restored account/session does not inherit Notes authority');
  }, {env: {MESH_MESH_PLATFORM_CMD: platform, MESH_ARTIFACTS_CMD: helper, CLAUDE_CONFIG_DIR: undefined}, alphaExtra: {account: 'work'},
    prepare(home, confDir) {
      const account = path.join(home, '.agent-accounts/work/.claude');
      fs.mkdirSync(path.join(account, 'projects/fixture'), {recursive: true, mode: 0o700});
      fs.writeFileSync(path.join(account, `projects/fixture/${SID}.jsonl`), '{}\n', {mode: 0o600});
      fs.writeFileSync(path.join(confDir, 'accounts.json'), JSON.stringify({v: 1, accounts: [{id: 'work', label: 'Synthetic account', claude_config_dir: account}]}), {mode: 0o600});
      fs.writeFileSync(path.join(confDir, 'session-artifacts.json'), JSON.stringify({version: 1, sessions: [{session: {name: 'alpha', created: ALPHA_CREATED}, references: [reference]}]}), {mode: 0o600});
      originalGrant = JSON.stringify({version: 1, sessions: [{name: 'alpha', created: ALPHA_CREATED, nonce: '1'.repeat(32), tools: ['mint_share']}]});
      fs.writeFileSync(path.join(confDir, 'notes-grants.json'), originalGrant, {mode: 0o600});
    }, intercept(request: any) {if (request.op === 'new') sent.push(request);}});
});
