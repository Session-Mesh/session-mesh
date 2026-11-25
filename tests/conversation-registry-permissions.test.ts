// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {withHistoryLab} from './history-resume-name-lib.ts';
import {REPO} from './mesh-server-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

const helper = process.env.MESH_MESH_HISTORY_CMD || path.join(REPO, 'ocaml/_build/default/bin/mesh_history_main.exe');

test('a registry unreadable by the server does not prevent session operations',
  {skip: process.getuid?.() === 0 ? 'requires an unprivileged user to exercise EACCES' : false}, async () => {
    await withHistoryLab(async lab => {
      const session = await lab.create('claude');
      const registry = path.join(lab.where.confDir, 'conversation-names.json');
      const snapshot = path.join(lab.where.confDir, 'sessions-snapshot.json');
      const before = fs.readFileSync(registry);
      fs.chmodSync(registry, 0o000);
      try {
        assert.throws(() => fs.readFileSync(registry), (error: NodeJS.ErrnoException) => error.code === 'EACCES');
        const rename = await lab.call('POST', '/api/organize', {op: 'rename', id: session.name, label: 'Still works'});
        assert.equal(rename.status, 200, rename.text);
        await waitFor('recovery snapshot updated despite unreadable registry', 15000, async () => {
          await lab.sessions();
          const data = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
          return data.live.some((row: any) => row.name === session.name && row.org?.label === 'Still works');
        });
        const stop = await lab.call('POST', '/api/kill/' + session.name, {created: session.created});
        assert.equal(stop.status, 200, stop.text);
        assert.match(lab.serverOutput(), /conversation.name.*unreadable/i);
      } finally {
        fs.chmodSync(registry, 0o600);
      }
      assert.deepEqual(fs.readFileSync(registry), before);
    });
  });

test('a failed atomic write is still reported as an IO failure',
  {skip: process.getuid?.() === 0 ? 'requires an unprivileged user to exercise EACCES' : false}, async () => {
    await withHistoryLab(async lab => {
      const session = await lab.create('claude');
      const registry = path.join(lab.where.confDir, 'conversation-names.json');
      const before = fs.readFileSync(registry);
      fs.chmodSync(lab.where.confDir, 0o500);
      try {
        assert.throws(() => fs.accessSync(lab.where.confDir, fs.constants.W_OK),
          (error: NodeJS.ErrnoException) => error.code === 'EACCES');
        const frame = {version: 1, op: 'rename', name: session.name, created: session.created,
          old: '', new: 'Cannot write', now: Date.now() / 1000};
        const reply = execFileSync(helper, ['--conversation-names'], {encoding: 'utf8',
          env: {MESH_CONF_DIR: lab.where.confDir}, input: JSON.stringify(frame) + '\n'});
        assert.deepEqual(JSON.parse(reply), {version: 1, error: 'registry_io'});
      } finally {
        fs.chmodSync(lab.where.confDir, 0o700);
      }
      assert.deepEqual(fs.readFileSync(registry), before);
    });
  });
