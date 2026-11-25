// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {withHistoryLab} from './history-resume-name-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

const file = 'conversation-names.json';

test('corrupt names do not block rename, recovery snapshots or conditional stop', async () => {
  await withHistoryLab(async lab => {
    const session = await lab.create('claude');
    const registry = path.join(lab.where.confDir, file);
    const snapshot = path.join(lab.where.confDir, 'sessions-snapshot.json');
    const damaged = '[{"name":"incomplete"';
    fs.writeFileSync(registry, damaged);
    const renamed = await lab.call('POST', '/api/organize', {op: 'rename', id: session.name, label: 'Fresh label'});
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(fs.readFileSync(registry, 'utf8'), damaged);
    await waitFor('refreshed recovery snapshot', 15000, async () => {
      await lab.sessions();
      const data = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
      return data.live.some((row: any) => row.name === session.name && row.org?.label === 'Fresh label');
    });
    const stopped = await lab.call('POST', '/api/kill/' + session.name, {created: session.created});
    assert.equal(stopped.status, 200, stopped.text);
    assert.equal(fs.readFileSync(registry, 'utf8'), damaged);
    assert.match(lab.serverOutput(), /conversation.name.*unreadable/i);
  });
});

test('a lock error remains visible and does not authorize a conditional stop', async () => {
  await withHistoryLab(async lab => {
    const session = await lab.create('claude');
    const lock = path.join(lab.where.confDir, 'conversation-names.lock');
    fs.unlinkSync(lock);
    fs.mkdirSync(lock);
    const stopped = await lab.call('POST', '/api/kill/' + session.name, {created: session.created});
    assert.equal(stopped.status, 500, stopped.text);
    assert.ok(fs.statSync(lock).isDirectory());
    assert.match(lab.serverOutput(), /conversation-name operation failed/);
  });
});
