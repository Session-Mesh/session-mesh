// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {withHistoryLab} from './history-resume-name-lib.ts';
import {REPO} from './mesh-server-lib.ts';

type Binding = {name: string; label: string};
const file = 'conversation-names.json';
const helper = process.env.MESH_MESH_HISTORY_CMD || path.join(REPO, 'ocaml/_build/default/bin/mesh_history_main.exe');

test('registry honors its own helper override even when the history index is disabled', async () => {
  await withHistoryLab(async lab => {
    lab.where.env.MESH_MESH_HISTORY_CMD = helper;
    lab.where.env.MESH_HISTORY_DB_DISABLE = '1';
    lab.where.env.MESH_OPAM_SWITCH = path.join(lab.where.scratch, 'no-such-switch');
    await lab.restartServer();
    const session = await lab.create('claude');
    await lab.rename(session.name, 'Override label');
    const rows = JSON.parse(fs.readFileSync(path.join(lab.where.confDir, file), 'utf8'));
    assert.ok(rows.some((row: Binding) => row.name === session.name && row.label === 'Override label'));
  });
});
