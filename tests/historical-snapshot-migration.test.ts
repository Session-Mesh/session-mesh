// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// Opt-in integration test: real, digest-pinned historical web sources and PTY hosts,
// then this tree's web server and selected native host, in a disposable HOME only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {REPO, scratchHome, runServer, stopServer, removeScratch} from './mesh-server-lib.ts';
import {startTestPtyhost} from './helpers/managed-test-ptyhost.ts';
import {waitFor} from './ptyhost-wire-lib.ts';
import {candidateHistoryFor, historicalArtifacts} from './helpers/historical-artifacts.ts';

const artifacts = process.env.MESH_HISTORICAL_ARTIFACTS;
const candidate = process.env.MESH_PTYHOST_CMD;
const required = process.env.MESH_REQUIRE_HISTORICAL_MIGRATION === '1';
const supported = process.platform === 'linux' && process.arch === 'x64';
const skip = !required && (!supported || !artifacts || !candidate)
  ? 'Linux x86_64; set MESH_HISTORICAL_ARTIFACTS and MESH_PTYHOST_CMD' : false;
const selected = historicalArtifacts(artifacts);
const versions = [selected.stable, selected.nightly];
const sha = (file:string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

for (const version of versions) test(`${version.tag} real snapshot survives upgrade to candidate`, {skip, timeout:90000}, async (t) => {
  const requestSignal = () => AbortSignal.any([t.signal, AbortSignal.timeout(10000)]);
  assert.ok(supported, 'historical binaries require Linux x86_64');
  assert.ok(artifacts, 'MESH_HISTORICAL_ARTIFACTS required');
  assert.ok(candidate && path.isAbsolute(candidate) && !candidate.includes(' '), 'MESH_PTYHOST_CMD must name one absolute binary');
  if (required) assert.match(process.env.MESH_CANDIDATE_PTYHOST_SHA256 ?? '', /^[0-9a-f]{64}$/,
    'MESH_CANDIDATE_PTYHOST_SHA256 required for qualification');
  const archive = path.join(artifacts, version.archive), oldHost = path.join(artifacts, version.host);
  assert.equal(sha(archive), version.archiveSha, 'historical source archive digest');
  assert.equal(sha(oldHost), version.hostSha, 'historical PTY host digest');
  const oldHistory = version.history ? path.join(artifacts, version.history) : undefined;
  if (oldHistory) assert.equal(sha(oldHistory), version.historySha, 'historical history helper digest');
  const candidateHistory = candidateHistoryFor(candidate);
  const where = await scratchHome('mesh-historical-migration-');
  // Do not inherit provider credentials or paths from the developer's environment.
  where.env = {HOME:where.home, PATH:'/usr/bin:/bin', LANG:'C.UTF-8', LANGUAGE:'en', SHELL:'/bin/bash',
    XDG_RUNTIME_DIR:path.join(where.home,'run'), XDG_CONFIG_HOME:path.join(where.home,'.config'),
    XDG_CACHE_HOME:path.join(where.home,'.cache'), MESH_CONF_DIR:where.confDir,
    MESH_CACHE_DIR:path.join(where.home,'.cache/session-mesh'), MESH_PORT:String(where.port),
    MESH_SESSIONS_WAIT:'60', MESH_TEST_SESSIONS_COMPLETE:'1',
    MESH_MESH_HISTORY_CMD: oldHistory ?? candidateHistory};
  const source = path.join(where.scratch,'old');
  const oldCopy = path.join(where.scratch,'old-ptyhost');
  const socket = path.join(where.home,'run/session-mesh/ptyhost.sock');
  const hostEnv = {HOME:where.home, PATH:'/usr/bin:/bin', SHELL:'/bin/bash', LANG:'C.UTF-8', XDG_RUNTIME_DIR:path.join(where.home,'run')};
  let host: ReturnType<typeof startTestPtyhost> | undefined, server: ChildProcess | undefined;
  try {
    fs.mkdirSync(source);
    execFileSync('tar',['-xzf',archive,'-C',source,'--strip-components=1']);
    fs.copyFileSync(oldHost,oldCopy); fs.chmodSync(oldCopy,0o700);
    const candidateDigest = sha(candidate);
    if (process.env.MESH_CANDIDATE_PTYHOST_SHA256) assert.equal(candidateDigest, process.env.MESH_CANDIDATE_PTYHOST_SHA256);
    console.log(`candidate PTY host sha256:${candidateDigest}`);
    host = startTestPtyhost([oldCopy], {cwd:source, env:hostEnv, stdio:'ignore'}, socket); await host.ready;
    const prior = await runServer(where, source); assert.ok(prior.result.listened, prior.output()); server = prior.child;
    const token = fs.readFileSync(path.join(where.confDir,'token'),'utf8').trim();
    const headers = {Authorization:`Bearer ${token}`, Origin:`http://127.0.0.1:${where.port}`, 'Content-Type':'application/json'};
    const url = `http://127.0.0.1:${where.port}`;
    const directories = Object.fromEntries(['alpha','bravo'].map(name => {
      const cwd = path.join(where.home,`work-${name}`); fs.mkdirSync(cwd, {mode:0o700}); return [name,cwd];
    }));
    for (const name of ['alpha','bravo']) {
      const response = await fetch(`${url}/api/new`, {method:'POST', headers, signal:requestSignal(), body:JSON.stringify({preset:'shell', cwd:directories[name], name})});
      assert.equal(response.status,200,await response.text());
    }
    const snapshot = path.join(where.confDir,'sessions-snapshot.json');
    await waitFor('historical snapshot',15000,async () => {
      await fetch(`${url}/api/sessions`,{headers, signal:requestSignal()});
      if (!fs.existsSync(snapshot)) return false;
      return JSON.parse(fs.readFileSync(snapshot,'utf8')).live?.length === 2;
    });
    const before = fs.readFileSync(snapshot);
    const historical = JSON.parse(before.toString()).live as {name:string; cwd:string; agent:unknown}[];
    assert.deepEqual(historical.map(row => [row.name,row.cwd,row.agent]).sort(),
      [['alpha',directories.alpha,null],['bravo',directories.bravo,null]]);
    await stopServer(server); server = undefined; await host.stop(); host = undefined;
    where.env.MESH_MESH_HISTORY_CMD = candidateHistory;
    const next = await runServer(where, REPO); assert.ok(next.result.listened, next.output()); server = next.child;
    await fetch(`${url}/api/sessions`,{headers, signal:requestSignal()});
    assert.deepEqual(fs.readFileSync(snapshot), before, 'unavailable host must not overwrite historical snapshot');
    host = startTestPtyhost([candidate], {cwd:REPO, env:hostEnv, stdio:'ignore'}, socket); await host.ready;
    let offers: any[] = [];
    await waitFor('restorable historical sessions',15000,async () => {
      const response = await fetch(`${url}/api/sessions`,{headers, signal:requestSignal()});
      offers = (await response.json()).restorable ?? [];
      return offers.length === 2;
    });
    assert.deepEqual(offers.map(offer => offer.name).sort(), ['alpha','bravo']);
    for (const offer of offers) {
      assert.equal(offer.cwd, directories[offer.name]);
      assert.equal(offer.agent, null);
    }
    const restored = await fetch(`${url}/api/restore`,{method:'POST',headers,signal:requestSignal(),body:JSON.stringify({names:['alpha','bravo']})});
    assert.equal(restored.status,200,await restored.clone().text());
    const body = await restored.json();
    assert.equal(body.results.alpha.ok,true); assert.equal(body.results.bravo.ok,true);
    let restoredRows: {name:string; cwd:string; agent:unknown}[] = [];
    await waitFor('restored sessions recorded',15000,async () => {
      const response = await fetch(`${url}/api/sessions`,{headers, signal:requestSignal()});
      const data = await response.json();
      restoredRows = data.mesh ?? [];
      const names = restoredRows.map(row => row.name).sort();
      return JSON.stringify(names) === JSON.stringify(['alpha','bravo']) && (data.restorable ?? []).length === 0;
    });
    assert.deepEqual(restoredRows.map(row => [row.name,row.cwd,row.agent]).sort(),
      [['alpha',directories.alpha,null],['bravo',directories.bravo,null]]);
  } finally {
    try { if (server) await stopServer(server); } finally {
      try { await host?.stop(); } finally { removeScratch(where.scratch); }
    }
  }
});
