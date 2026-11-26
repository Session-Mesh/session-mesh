// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {withHistoryLab} from './history-resume-name-lib.ts';
import {REPO} from './mesh-server-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

const helper = process.env.MESH_MESH_HISTORY_CMD || path.join(REPO, 'ocaml/_build/default/bin/mesh_history_main.exe');
const quoted = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

test('an old History override does not receive registry reads or writes', async () => {
  await withHistoryLab(async lab => {
    const marker = path.join(lab.where.scratch, 'old-helper-invoked');
    const old = process.env.MESH_TEST_LEGACY_HISTORY_CMD || path.join(lab.where.scratch, 'old-history-helper');
    if (!process.env.MESH_TEST_LEGACY_HISTORY_CMD) {
      fs.writeFileSync(old, `#!/bin/sh\nprintf 'called\\n' >> ${quoted(marker)}\nprintf '{"ok":false}\\n'\n`, {mode: 0o700});
    }
    fs.symlinkSync(helper, path.join(lab.bin, 'mesh-history'));
    lab.where.env.MESH_MESH_HISTORY_CMD = undefined;
    lab.where.env.MESH_HISTORY_CMD = old;
    lab.where.env.MESH_HISTORY_DB_DISABLE = '1';
    await lab.restartServer();
    const first = await lab.call('GET', '/api/history');
    assert.equal(first.status, 200, first.text);
    const session = await lab.create('claude');
    await lab.rename(session.name, 'Native registry');
    const reply = await lab.call('GET', '/api/history');
    assert.equal(reply.status, 200, reply.text);
    assert.ok(Array.isArray(reply.json.mesh_names));
    assert.equal(fs.existsSync(marker), false);
  });
});

test('the History index still launches its existing override', async () => {
  await withHistoryLab(async lab => {
    const marker = path.join(lab.where.scratch, 'index-helper-invoked');
    const wrapper = path.join(lab.where.scratch, 'index-helper');
    fs.writeFileSync(wrapper, '#!/bin/sh\n' +
      'test -n "$HOME" || exit 41\n' +
      'test "${MESH_HISTORY_DB##*/}" = history.sqlite || exit 42\n' +
      `printf '%s\\n' "$*" >> ${quoted(marker)}\n` +
      `exec ${quoted(helper)} "$@"\n`, {mode: 0o700});
    fs.symlinkSync(helper, path.join(lab.bin, 'mesh-history'));
    lab.where.env.MESH_MESH_HISTORY_CMD = undefined;
    lab.where.env.MESH_HISTORY_CMD = wrapper;
    lab.where.env.MESH_HISTORY_DB_DISABLE = undefined;
    await lab.restartServer();
    const reply = await lab.call('GET', '/api/history');
    assert.equal(reply.status, 200, reply.text);
    await waitFor('History launches its configured helper', 5000, () => fs.existsSync(marker));
    assert.doesNotMatch(fs.readFileSync(marker, 'utf8'), /--conversation-names/);
  });
});

test('index and registry work together with a historical index helper', async () => {
  await withHistoryLab(async lab => {
    const marker = path.join(lab.where.scratch, 'history-index-calls');
    const wrapper = path.join(lab.where.scratch, 'history-index-wrapper');
    const indexHelper = process.env.MESH_TEST_LEGACY_HISTORY_CMD || helper;
    fs.writeFileSync(wrapper, '#!/bin/sh\n' +
      `printf '%s\\n' "$*" >> ${quoted(marker)}\n` +
      `exec ${quoted(indexHelper)} "$@"\n`, {mode: 0o700});
    fs.symlinkSync(helper, path.join(lab.bin, 'mesh-history'));
    lab.where.env.MESH_MESH_HISTORY_CMD = undefined;
    lab.where.env.MESH_HISTORY_CMD = wrapper;
    lab.where.env.MESH_HISTORY_DB_DISABLE = undefined;
    await lab.restartServer();
    const session = await lab.create('claude');
    await lab.rename(session.name, 'Concurrent index');
    const reply = await lab.call('GET', '/api/history');
    assert.equal(reply.status, 200, reply.text);
    await waitFor('History index helper starts', 5000, () => fs.existsSync(marker));
    assert.doesNotMatch(fs.readFileSync(marker, 'utf8'), /--conversation-names/);
    const registry = JSON.parse(fs.readFileSync(path.join(lab.where.confDir, 'conversation-names.json'), 'utf8'));
    assert.ok(registry.some((row: {name: string; label: string}) => row.name === session.name && row.label === 'Concurrent index'));
  });
});
