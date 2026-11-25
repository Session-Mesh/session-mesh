// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {withHistoryLab} from './history-resume-name-lib.ts';
import {REPO} from './mesh-server-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

const helper = process.env.MESH_MESH_HISTORY_CMD || path.join(REPO, 'ocaml/_build/default/bin/mesh_history_main.exe');
const quoted = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function useWrapper(lab: any, body: string): Promise<void> {
  const wrapper = path.join(lab.where.scratch, 'history-wrapper');
  fs.writeFileSync(wrapper, '#!/bin/sh\n' + body + '\n', {mode: 0o700});
  lab.where.env.MESH_MESH_HISTORY_CMD = undefined;
  lab.where.env.MESH_HISTORY_CMD = wrapper;
  lab.where.env.MESH_HISTORY_DB_DISABLE = '1';
  lab.where.env.MESH_OPAM_SWITCH = path.join(lab.where.scratch, 'no-such-switch');
  await lab.restartServer();
}

test('historical non-exec wrapper and a wrapper which drains stdin work', async () => {
  await withHistoryLab(async lab => {
    for (const body of [
      `${quoted(helper)} "$@"`,
      `cat > ${quoted(path.join(lab.where.scratch, 'frame'))}\n${quoted(helper)} "$@" < ${quoted(path.join(lab.where.scratch, 'frame'))}`,
    ]) {
      await useWrapper(lab, body);
      const reply = await lab.call('GET', '/api/history');
      assert.equal(reply.status, 200, reply.text);
      assert.ok(Array.isArray(reply.json.mesh_names));
    }
  });
});

test('a wrapper which closes inherited descriptors is refused safely', async () => {
  await withHistoryLab(async lab => {
    await lab.create('claude');
    const registry = path.join(lab.where.confDir, 'conversation-names.json');
    const before = fs.readFileSync(registry);
    const wrapper = path.join(lab.where.scratch, 'closing-wrapper');
    fs.writeFileSync(wrapper, `#!${process.execPath}\nconst {spawnSync} = require('node:child_process');\n` +
      `const r = spawnSync(${JSON.stringify(helper)}, process.argv.slice(2), {stdio: 'inherit'});\n` +
      `process.exit(r.status ?? 1);\n`, {mode: 0o700});
    lab.where.env.MESH_MESH_HISTORY_CMD = undefined;
    lab.where.env.MESH_HISTORY_CMD = wrapper;
    lab.where.env.MESH_HISTORY_DB_DISABLE = '1';
    await lab.restartServer();
    const reply = await lab.call('GET', '/api/history');
    assert.equal(reply.status, 500, reply.text);
    assert.deepEqual(fs.readFileSync(registry), before);
    assert.match(lab.serverOutput(), /mesh-history conversation-name lifetime signal unavailable/);
  });
});

const flockPresent = spawnSync('flock', ['--version'], {stdio: 'ignore'}).status === 0;
test('wrapped helper exits without mutation when the server dies waiting on the lock',
  {skip: flockPresent ? false : 'requires the flock utility; native flock coverage runs separately'}, async () => {
    await withHistoryLab(async lab => {
      const session = await lab.create('claude');
      const registry = path.join(lab.where.confDir, 'conversation-names.json');
      const lock = path.join(lab.where.confDir, 'conversation-names.lock');
      const directory = path.join(lab.where.scratch, 'children');
      fs.mkdirSync(directory);
      await useWrapper(lab, `frame=${quoted(directory)}/"$$.frame"\ncat > "$frame"\n` +
        `${quoted(helper)} "$@" < "$frame" &\nchild=$!\n` +
        `case "$(cat "$frame")" in *'"op":"rename"'*) printf '%s\\n' "$child" >> ${quoted(path.join(directory, 'started'))};; esac\n` +
        `wait "$child"\n: > ${quoted(directory)}/"$child.done"`);
      await lab.sessions();
      const holder = spawn('flock', ['-x', lock, 'sh', '-c', 'printf "ready\\n"; cat >/dev/null'], {stdio: ['pipe', 'pipe', 'pipe']});
      try {
        await waitFor('exclusive registry lock held', 5000, () => holder.stdout!.read()?.toString().includes('ready') === true);
        const before = fs.readFileSync(registry);
        const started = path.join(directory, 'started');
        const old = fs.existsSync(started) ? fs.readFileSync(started, 'utf8').trim().split('\n').filter(Boolean) : [];
        const request = lab.call('POST', '/api/organize', {op: 'rename', id: session.name, label: 'Delayed'}).catch(() => null);
        let child = '';
        await waitFor('wrapper starts a locked helper', 5000, () => {
          const values = fs.existsSync(started) ? fs.readFileSync(started, 'utf8').trim().split('\n') : [];
          child = values.slice(old.length).find((pid: string) => !fs.existsSync(path.join(directory, `${pid}.done`))) || '';
          return child !== '';
        });
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(fs.existsSync(path.join(directory, `${child}.done`)), false, 'helper must wait while server is alive');
        const server = (lab as any).server as ChildProcess;
        const closed = new Promise<void>(resolve => server.once('close', () => resolve()));
        server.kill('SIGKILL');
        await closed;
        await waitFor('orphaned helper exits before lock release', 5000, () => fs.existsSync(path.join(directory, `${child}.done`)));
        assert.deepEqual(fs.readFileSync(registry), before);
        holder.stdin!.end();
        await request;
        assert.deepEqual(fs.readFileSync(registry), before);
      } finally {
        holder.stdin?.end();
        holder.kill('SIGKILL');
      }
    });
  });
