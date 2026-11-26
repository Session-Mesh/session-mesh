// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {withHistoryLab} from './history-resume-name-lib.ts';
import {REPO} from './mesh-server-lib.ts';

const helper = process.env.MESH_MESH_HISTORY_CMD || path.join(REPO, 'ocaml/_build/default/bin/mesh_history_main.exe');
const quoted = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

test('the new registry override keeps the helper environment restricted', async () => {
  await withHistoryLab(async lab => {
    const wrapper = path.join(lab.where.scratch, 'registry-environment-wrapper');
    fs.writeFileSync(wrapper, '#!/bin/sh\n' +
      'test "${MESH_TEST_CREDENTIAL+set}" != set || exit 41\n' +
      'test "$(pwd -P)" = / || exit 42\n' +
      `exec ${quoted(helper)} "$@"\n`, {mode: 0o700});
    lab.where.env.MESH_MESH_HISTORY_CMD = wrapper;
    lab.where.env.MESH_TEST_CREDENTIAL = 'private';
    await lab.restartServer();
    const reply = await lab.call('GET', '/api/history');
    assert.equal(reply.status, 200, reply.text);
    assert.ok(Array.isArray(reply.json.mesh_names));
  });
});
