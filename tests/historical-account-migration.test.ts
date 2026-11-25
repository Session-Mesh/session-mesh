// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// Real previous-nightly legacy alias and PTY; synthetic account, conversation and agent only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {REPO, scratchHome, runServer, stopServer, removeScratch} from './mesh-server-lib.ts';
import {startTestPtyhost} from './helpers/managed-test-ptyhost.ts';
import {cleanupHistoricalFixture} from './helpers/historical-cleanup.ts';
import {installFakeCodex, launchesIn} from './fake-codex-lib.ts';
import {appendFixturePath} from './fixture-login-path.ts';
import {request, waitFor} from './ptyhost-wire-lib.ts';

const artifacts = process.env.MESH_HISTORICAL_ARTIFACTS;
const candidateHost = process.env.MESH_PTYHOST_CMD;
const candidatePlatform = process.env.MESH_CANDIDATE_PLATFORM_CMD;
const required = process.env.MESH_REQUIRE_HISTORICAL_MIGRATION === '1';
const supported = process.platform === 'linux' && process.arch === 'x64';
const skip = !required && (!supported || !artifacts || !candidateHost || !candidatePlatform)
  ? 'Linux x86_64; set historical artifacts, candidate PTY host and candidate platform' : false;
const sha = (file:string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// The private fixture host owns this socket and records each incarnation. Ask
// it to retire exactly that incarnation; never signal a bare, reusable PID.
async function retireFixtureSession(socket: string): Promise<void> {
  const rows = await request(socket,{op:'list'}) as {name:string; created:number}[];
  assert.ok(rows.every(row => row.name === 'alias-session'), 'unexpected session in fixture host');
  for (const row of rows) {
    const result = await request(socket,{op:'kill_if',name:row.name,created:row.created}) as {ok:boolean};
    assert.equal(result.ok,true,'fixture incarnation retired');
  }
  await waitFor('fixture session retirement',15000,async () =>
    ((await request(socket,{op:'list'})) as unknown[]).length === 0);
}

for (const removeAlias of [false,true]) test(`previous nightly account ${removeAlias ? 'removed: refuse fallback' : 'preserved: resume same alias'}`, {skip,timeout:90000}, async () => {
  assert.ok(supported && artifacts && candidateHost && candidatePlatform);
  for (const binary of [candidateHost,candidatePlatform]) assert.ok(path.isAbsolute(binary) && !binary.includes(' '));
  const expectedHost = process.env.MESH_CANDIDATE_PTYHOST_SHA256;
  const expectedPlatform = process.env.MESH_CANDIDATE_PLATFORM_SHA256;
  if (required) for (const digest of [expectedHost,expectedPlatform]) assert.match(digest ?? '', /^[0-9a-f]{64}$/);
  if (expectedHost) assert.equal(sha(candidateHost),expectedHost);
  if (expectedPlatform) assert.equal(sha(candidatePlatform),expectedPlatform);
  const archive = path.join(artifacts,'session-mesh-v0.2.0-nightly.20261124.tar.gz');
  const oldHost = path.join(artifacts,'nightly-20261124/mesh-ptyhost-linux-x86_64');
  const oldPlatform = path.join(artifacts,'nightly-20261124/mesh-platform-linux-x86_64');
  assert.equal(sha(archive),'58ea5761fc840ca2269e1a31c81566cb0c1fb6af6e94354c85be6989c2a63342');
  assert.equal(sha(oldHost),'23e83e42ee335315eebb950469f6a690682d5ec417a451997e4b32cfb446269a');
  assert.equal(sha(oldPlatform),'883ae2892e3c2aa93e89a1acf828002bd97a19afb68b6971d9b4d825ecc8011f');
  const where = await scratchHome('mesh-historical-account-');
  const source = path.join(where.scratch,'old'), bin = path.join(where.scratch,'bin');
  const socket = path.join(where.home,'run/session-mesh/ptyhost.sock');
  const aliasHome = path.join(where.home,'.agent-accounts','work','.codex');
  const accounts = path.join(where.confDir,'accounts.json');
  const hostEnv = {HOME:where.home, PATH:`${bin}:/usr/bin:/bin`, SHELL:'/bin/bash', LANG:'C.UTF-8', XDG_RUNTIME_DIR:path.join(where.home,'run')};
  let host: ReturnType<typeof startTestPtyhost> | undefined, server: ChildProcess | undefined;
  let retirementUncertain: unknown;
  let hostStopUncertain: unknown;
  try {
    fs.mkdirSync(source); fs.mkdirSync(bin); fs.mkdirSync(aliasHome,{recursive:true,mode:0o700});
    fs.mkdirSync(where.confDir,{recursive:true,mode:0o700});
    execFileSync('tar',['-xzf',archive,'-C',source,'--strip-components=1']);
    const oldHostCopy = path.join(bin,'old-ptyhost'), oldPlatformCopy = path.join(bin,'old-platform');
    fs.copyFileSync(oldHost,oldHostCopy); fs.chmodSync(oldHostCopy,0o700);
    fs.copyFileSync(oldPlatform,oldPlatformCopy); fs.chmodSync(oldPlatformCopy,0o700);
    const fake = installFakeCodex(bin); appendFixturePath(where.home,hostEnv.PATH);
    const original = JSON.stringify({v:1,accounts:[{id:'work',label:'Work',codex_home:aliasHome}]});
    fs.writeFileSync(accounts,original,{mode:0o600});
    where.env = {...hostEnv, LANGUAGE:'en', XDG_CONFIG_HOME:path.join(where.home,'.config'),
      XDG_CACHE_HOME:path.join(where.home,'.cache'), MESH_CONF_DIR:where.confDir,
      MESH_CACHE_DIR:path.join(where.home,'.cache/session-mesh'), MESH_PORT:String(where.port),
      MESH_SESSIONS_WAIT:'60', MESH_TEST_SESSIONS_COMPLETE:'1', MESH_MESH_PLATFORM_CMD:oldPlatformCopy};
    host = startTestPtyhost([oldHostCopy],{cwd:source,env:hostEnv,stdio:'ignore'},socket); await host.ready;
    const prior = await runServer(where,source); assert.ok(prior.result.listened,prior.output()); server = prior.child;
    const token = fs.readFileSync(path.join(where.confDir,'token'),'utf8').trim();
    const url = `http://127.0.0.1:${where.port}`;
    const headers = {Authorization:`Bearer ${token}`, Origin:url, 'Content-Type':'application/json'};
    const start = await fetch(`${url}/api/new`,{method:'POST',headers,body:JSON.stringify({preset:'codex',name:'alias-session',cwd:where.home,account:'work'})});
    assert.equal(start.status,200,await start.text());
    const snapshot = path.join(where.confDir,'sessions-snapshot.json');
    let sid = '', agentPid = 0;
    await waitFor('historical account session',20000,async () => {
      const rows = (await (await fetch(`${url}/api/sessions`,{headers})).json()).mesh ?? [];
      const row = rows.find((item:{name:string}) => item.name === 'alias-session');
      sid = row?.agent?.session_id ?? ''; agentPid = row?.agent?.pid ?? 0;
      return !!sid && agentPid > 0 && fs.existsSync(snapshot) && JSON.parse(fs.readFileSync(snapshot,'utf8')).live?.[0]?.agent?.session_id === sid;
    });
    const recorded = JSON.parse(fs.readFileSync(snapshot,'utf8')).live[0];
    assert.equal(recorded.account,'work'); assert.equal(recorded.agent.type,'codex'); assert.equal(recorded.cwd,where.home);
    assert.equal(launchesIn(fake.log)[0]?.[1],aliasHome);
    await stopServer(server); server = undefined;
    try { await retireFixtureSession(socket); } catch (error) { retirementUncertain = error; throw error; }
    try { await host.stop(); } catch (error) { hostStopUncertain = error; throw error; }
    host = undefined;
    if (removeAlias) fs.writeFileSync(accounts,JSON.stringify({v:1,accounts:[]}),{mode:0o600});
    where.env.MESH_MESH_PLATFORM_CMD = candidatePlatform;
    const next = await runServer(where,REPO); assert.ok(next.result.listened,next.output()); server = next.child;
    host = startTestPtyhost([candidateHost],{cwd:REPO,env:hostEnv,stdio:'ignore'},socket); await host.ready;
    let offer: any;
    await waitFor('historical alias recovery offer',15000,async () => {
      const data = await (await fetch(`${url}/api/sessions`,{headers})).json();
      offer = data.restorable?.find((item:{name:string}) => item.name === 'alias-session'); return !!offer;
    });
    assert.equal(offer.agent,'codex'); assert.equal(offer.cwd,where.home);
    const lost = JSON.parse(fs.readFileSync(snapshot,'utf8')).lost.find((item:{name:string}) => item.name === 'alias-session');
    assert.equal(lost.account,'work'); assert.equal(lost.agent.session_id,sid);
    const response = await fetch(`${url}/api/restore`,{method:'POST',headers,body:JSON.stringify({names:['alias-session']})});
    assert.equal(response.status,200,await response.clone().text());
    const result = (await response.json()).results['alias-session'];
    if (removeAlias) {
      assert.equal(result.ok,false); assert.match(result.error,/unknown account alias/i);
      assert.equal(launchesIn(fake.log).length,1,'no fallback launch');
      assert.equal(fs.existsSync(path.join(where.home,'.codex')),false);
      const retained = JSON.parse(fs.readFileSync(snapshot,'utf8')).lost.find((item:{name:string}) => item.name === 'alias-session');
      assert.equal(retained.account,'work'); assert.equal(retained.agent.session_id,sid);
    } else {
      assert.equal(result.ok,true,JSON.stringify(result)); assert.equal(result.resumed,true,JSON.stringify(result));
      await waitFor('resumed synthetic agent',15000,() => launchesIn(fake.log).length === 2);
      const resumed = launchesIn(fake.log)[1]!;
      assert.equal(resumed[1],aliasHome); assert.match(resumed[3],new RegExp(sid));
      await waitFor('resumed account identity',15000,async () => {
        const data = await (await fetch(`${url}/api/sessions`,{headers})).json();
        const row = data.mesh?.find((item:{name:string}) => item.name === 'alias-session');
        return row?.account === 'work' && row?.agent?.session_id === sid && row?.cwd === where.home;
      });
      assert.equal(fs.readFileSync(accounts,'utf8'),original);
      assert.equal(fs.existsSync(path.join(where.home,'.codex')),false);
    }
  } finally {
    await cleanupHistoricalFixture(where.scratch, {
      stopServer: async () => { if (server) await stopServer(server); },
      retireHost: async () => { if (retirementUncertain) throw retirementUncertain; if (host) await retireFixtureSession(socket); },
      stopHost: async () => { if (hostStopUncertain) throw hostStopUncertain; if (host) await host.stop(); },
      removeScratch: () => removeScratch(where.scratch),
    });
  }
});
