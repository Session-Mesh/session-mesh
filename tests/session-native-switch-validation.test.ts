// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// Linux end-to-end qualification with isolated account homes and fake agents.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {rolloutIn} from './fake-codex-lib.ts';
import {mesh, log, travelHome, workHome, sleep, launches, owner, codexSession, listed, ask,
  installNativeProfiles, unchangedSource, requested, decide, launchOf} from './session-account-switch-fixture.ts';

describe('native switch integration', {skip: process.platform !== 'linux' ? 'process environment binding needs Linux procfs' : false}, () => {
  test('default to work and work to travel keeps terminal and identity', async () => {
    const registry = installNativeProfiles();
    try {
      const parallel = await codexSession('x-parallel', 'travel');
      const parallelBefore = (await listed(parallel.name))!;
      const session = await codexSession('x-native-int');
      const before = await listed(session.name);
      const self = await fetch(`${mesh.base}/api/session-actions/@self/accounts`,
        {headers: {Authorization: `MeshSession ${session.token}`}});
      assert.equal(self.status, 200, await self.clone().text());
      assert.equal((await self.json() as {switch_qualified:boolean}).switch_qualified, true);
      const profiles = await fetch(`${mesh.base}/api/accounts/profiles`, {headers: owner()});
      assert.equal(profiles.status, 200);
      assert.ok((await profiles.json() as {data:{profiles:{switch_qualified:boolean}[]}})
        .data.profiles.every(profile => profile.switch_qualified));
      const request = await requested(session, 'work');
      const done = await decide(request, true);
      assert.equal(done.state, 'completed', JSON.stringify(done));
      assert.equal(done.result?.id, session.name);
      assert.equal((await launchOf(session.name))[0], workHome);
      assert.equal(fs.existsSync(rolloutIn(workHome, session.sid)), true);
      const after = await listed(session.name);
      assert.equal(after?.id, before?.id);
      assert.equal(launches().findLast(fields => fields[2] === session.name)?.[4], session.token);
      const parallelAfter = (await listed(parallel.name))!;
      assert.equal(parallelAfter.created, parallelBefore.created);
      assert.equal((parallelAfter.agent as {pid:number}).pid, (parallelBefore.agent as {pid:number}).pid);
      const request2 = await requested(session, 'travel');
      const done2 = await decide(request2, true);
      assert.equal(done2.state, 'completed', JSON.stringify(done2));
      for (let i = 0; i < 100 && (await launchOf(session.name))[0] !== travelHome; i++) await sleep(100);
      assert.equal((await launchOf(session.name))[0], travelHome);
      const request3 = await requested(session, 'default');
      const done3 = await decide(request3, true);
      assert.equal(done3.state, 'completed', JSON.stringify(done3));
      for (let i = 0; i < 100 && (await launchOf(session.name))[0] !== path.join(mesh.home, '.codex'); i++) await sleep(100);
      assert.equal((await launchOf(session.name))[0], path.join(mesh.home, '.codex'));
      const restart = await ask(session, {action: 'restart'});
      assert.equal(restart.status, 202, await restart.clone().text());
      const restartRequest = (await restart.json() as {request: Parameters<typeof decide>[0]}).request;
      const restarted = await decide(restartRequest, true);
      assert.equal(restarted.state, 'completed', JSON.stringify(restarted));
    } finally { fs.rmSync(registry); }
  });
  test('registry target changes after approval request refuse before stopping', async () => {
    const registry = installNativeProfiles();
    try {
      const session = await codexSession('x-native-stale', 'work');
      const before = (await listed(session.name))!;
      const logBefore = fs.readFileSync(log, 'utf8');
      const request = await requested(session, 'travel');
      const data = JSON.parse(fs.readFileSync(registry, 'utf8'));
      data.profiles = data.profiles.filter((profile: {id:string}) => profile.id !== 'travel');
      fs.writeFileSync(registry, JSON.stringify(data), {mode: 0o600});
      const done = await decide(request, true);
      assert.equal(done.state, 'failed', JSON.stringify(done));
      await unchangedSource(session, before, logBefore);
      assert.equal(fs.existsSync(rolloutIn(travelHome, session.sid)), false);
    } finally { fs.rmSync(registry); }
  });

  test('failed carry resumes default in place without affecting another account', async () => {
    const registry = installNativeProfiles();
    try {
      const parallel = await codexSession('x-parallel-rollback', 'travel');
      const parallelBefore = (await listed(parallel.name))!;
      const session = await codexSession('x-native-rollback');
      const target = rolloutIn(workHome, session.sid);
      fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
      fs.writeFileSync(target, '{"type":"session_meta","payload":{"other":"copy"}}\n', {mode: 0o600});
      const done = await decide(await requested(session, 'work'), true);
      assert.equal(done.state, 'failed', JSON.stringify(done));
      assert.equal(done.result?.rolled_back, true);
      assert.equal(done.result?.code, 'conversation_diverged');
      const [home] = await launchOf(session.name);
      assert.equal(home, path.join(mesh.home, '.codex'));
      assert.equal(launches().findLast(fields => fields[2] === session.name)?.[4], session.token);
      const parallelAfter = (await listed(parallel.name))!;
      assert.equal(parallelAfter.created, parallelBefore.created);
      assert.equal((parallelAfter.agent as {pid:number}).pid, (parallelBefore.agent as {pid:number}).pid);
    } finally { fs.rmSync(registry); }
  });

});
