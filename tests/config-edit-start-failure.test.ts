// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ConfigMesh} from './helpers/config-edit-mesh.ts';

test('an unavailable PTY rejects startup and releases the test server', async () => {
  const previous = process.env.MESH_PTYHOST_CMD;
  process.env.MESH_PTYHOST_CMD = '/nonexistent-mesh-test-ptyhost';
  try {
    await assert.rejects(ConfigMesh.start('config-start-failure-', null), {code: 'ENOENT'});
  } finally {
    if (previous === undefined) delete process.env.MESH_PTYHOST_CMD;
    else process.env.MESH_PTYHOST_CMD = previous;
  }
});
