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
      assert.match((done3.result as {notice?:string})?.notice ?? '', /retained for recovery/);
      for (let i = 0; i < 100 && (await launchOf(session.name))[0] !== path.join(mesh.home, '.codex'); i++) await sleep(100);
      assert.equal((await launchOf(session.name))[0], path.join(mesh.home, '.codex'));
      const beforeRestart = (await listed(session.name))!;
      const oldPid = (beforeRestart.agent as {pid:number}).pid;
      assert.ok(oldPid > 0);
      const launchCount = launches().filter(fields => fields[2] === session.name).length;
      const restart = await ask(session, {action: 'restart'});
      assert.equal(restart.status, 202, await restart.clone().text());
      const restartRequest = (await restart.json() as {request: Parameters<typeof decide>[0]}).request;
      const restarted = await decide(restartRequest, true);
      assert.equal(restarted.state, 'completed', JSON.stringify(restarted));
      for (let i = 0; i < 100 && launches().filter(fields => fields[2] === session.name).length <= launchCount; i++) await sleep(100);
      assert.ok(launches().filter(fields => fields[2] === session.name).length > launchCount, 'a new agent launch was observed');
      const latest = launches().findLast(fields => fields[2] === session.name)!;
      assert.equal(latest[1], path.join(mesh.home, '.codex'));
      assert.equal(latest[4], session.token, 'restart retains the same PTY session token');
      let afterRestart = (await listed(session.name))!;
      for (let i = 0; i < 100 && (!afterRestart.agent || (afterRestart.agent as {pid:number}).pid === oldPid); i++) {
        await sleep(100);
        afterRestart = (await listed(session.name))!;
      }
      assert.equal(afterRestart.id, before?.id);
      assert.equal(afterRestart.pid, beforeRestart.pid, 'the PTY shell stays the same');
      assert.notEqual(afterRestart.created, beforeRestart.created, 'restart advances the session incarnation');
      assert.ok((afterRestart.agent as {pid:number})?.pid > 0);
      assert.notEqual((afterRestart.agent as {pid:number}).pid, oldPid, 'agent was restarted');
      const parallelAfterRestart = (await listed(parallel.name))!;
      assert.equal(parallelAfterRestart.created, parallelBefore.created);
      assert.equal((parallelAfterRestart.agent as {pid:number}).pid, (parallelBefore.agent as {pid:number}).pid);
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
