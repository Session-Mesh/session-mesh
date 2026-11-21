// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {test} from 'node:test';
import {AgentMesh} from './helpers/agent-mail-mesh.ts';

test('a refused fake-agent startup releases its server, host and scratch directories', {timeout: 20000}, async () => {
  const prefix = 'mail-fail-' + crypto.randomUUID().slice(0, 8) + '-';
  await assert.rejects(AgentMesh.start(prefix, ['invalid/name']));
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(prefix)), []);
});
