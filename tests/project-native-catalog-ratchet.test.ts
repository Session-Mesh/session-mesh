// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { request, waitFor } from './ptyhost-wire-lib.ts';

/** Direct: 0=pass, 1=behavioral assertion, >=2=setup/runtime error. */
export async function checkNativeCatalogGate(): Promise<void> {
  const host = process.env.MESH_NATIVE_PTYHOST;
  if (!host || !fs.existsSync(host)) throw Error('explicit existing MESH_NATIVE_PTYHOST required');
  const entry = path.resolve(process.env.MESH_PROJECT_VALIDATOR_ENTRY || 'tools/project-observation.mjs');
  if (!fs.existsSync(entry)) throw Error('existing generated actual collector entry required');
  const root = fs.mkdtempSync('/tmp/mi1.rat.');
  const conf = path.join(root, 'conf'), runtime = path.join(root, 'run');
  fs.mkdirSync(conf, { mode: 0o700 }); fs.mkdirSync(runtime, { mode: 0o700 });
  const fixture = path.join(root, 'collector.mjs'), primary = path.join(root, 'primary');
  const validator = path.join(root, 'validator');
  fs.writeFileSync(fixture, `import fs from 'node:fs';import {main} from ${JSON.stringify(pathToFileURL(entry).href)};
if(process.argv[2]==='--validate-catalog'){fs.writeFileSync(${JSON.stringify(validator)},'actual C main');await main(['--validate-catalog']);}
else{let raw='';for await(const chunk of process.stdin)raw+=chunk;const i=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(primary)},'primary\\n');process.stdout.write(JSON.stringify({kind:'mesh-project-observation-output',version:1,observation_id:i.observation_id,boot:i.boot,scope:i.scope,settlement:{providers_closed:true,provider_pipes_closed:true},result:{state:'complete',catalog:{kind:'mesh-project-catalog',schema_version:2,features:['project-metadata/1','roster-followup/1'],machine_id:i.scope.machine_id,revision:'a'.repeat(64),generated_at:'2026-11-15T00:00:00Z',projects:[{id:i.scope.project_id,title:'Nested invalid',sources:[{id:'s',kind:'roster',label:'Source',status:'available',observed_at:'2026-11-15T00:00:00Z',summary:{bogus:true}}],sessions:[]}]}}}));}
`, { mode: 0o600 });
  fs.writeFileSync(path.join(conf, 'projects.json'), JSON.stringify({ kind: 'mesh-project-config', schema_version: 2,
    features: ['project-metadata/1', 'project-workspace/1', 'project-observation/1'], machine_id: 'host',
    projects: [{ id: 'one', title: 'One', sources: [], sessions: [], observation: { repository: false, source_ids: [] } }] }), { mode: 0o600 });
  const child = spawn(host, [], { env: { ...process.env, HOME: root, MESH_CONF_DIR: conf, XDG_RUNTIME_DIR: runtime,
    MESH_RUNTIME_DIR: runtime, MESH_PROJECT_OBSERVATION_RUNTIME: process.execPath, MESH_PROJECT_OBSERVATION_ENTRY: fixture }, stdio: 'ignore' });
  try {
    const socket = path.join(runtime, 'session-mesh', 'ptyhost.sock');
    let inventory: any;
    await waitFor('isolated native host', 4000, async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw Error('native host startup failed');
      try { inventory = await request(socket, { op: 'project_list', version: 1 }); return inventory.status === 'ok'; } catch { return false; }
    });
    const request_id = '00000000-0000-4000-8000-000000000091';
    const start: any = await request(socket, { op: 'project_observation_start', version: 1, boot: inventory.boot,
      machine_id: 'host', project_id: 'one', expected_revision: inventory.revision, request_id });
    assert.equal(start.status, 'ok');
    let status: any;
    await waitFor('native malformed catalog decision', 7000, async () => {
      status = await request(socket, { op: 'project_observation_status', version: 1, boot: inventory.boot,
        machine_id: 'host', project_id: 'one', requested_revision: inventory.revision, request_id, observation_id: start.observation_id });
      return ['complete', 'failed', 'cleanup-pending', 'cancelled'].includes(status.observation_state);
    });
    assert.notEqual(status.observation_state, 'complete', 'native must reject malformed nested catalog before publishing complete');
    assert.equal(status.observation_state, 'failed', 'actual C schema rejection with settled validator releases safely');
    assert.equal(status.code, 'collector-invalid');
    assert.equal(status.descriptor, undefined);
    assert.ok(fs.existsSync(validator), 'native delegated to actual C validator main');
    assert.equal(fs.readFileSync(primary, 'utf8'), 'primary\n', 'exactly one primary collector');
    console.log('native nested catalog gate: actual C schema rejection passed');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit'); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 4000); await done; clearTimeout(timer);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (process.env.NODE_TEST_CONTEXT) {
  test('native complete gate delegates rich nested admission to actual C schema', {
    skip: !process.env.MESH_NATIVE_PTYHOST && !process.env.MESH_REQUIRE_NATIVE_PROJECTS
      ? 'explicit native host required for native catalog ratchet' : false,
    timeout: 30000,
  }, checkNativeCatalogGate);
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await checkNativeCatalogGate(); }
  catch (error) { console.error(error); process.exitCode = error instanceof assert.AssertionError ? 1 : 2; }
}
