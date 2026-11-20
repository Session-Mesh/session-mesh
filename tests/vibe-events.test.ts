// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What `bin/mesh-event vibe` sends for the hook payloads Mistral Vibe 3.1.2 writes on a hook's standard input
// (the payload fields were captured from a real run: session_start, pre_agent, post_agent, notification), and
// the hooks file Mesh hands to Vibe. A local HTTP server stands in for the mesh; no Vibe and no model.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SESSION = 'e98ebb44-7316-c2a7-62cf-582ea59f42f6';
const TOKEN = 'ms1.vibe-test.nonce000000000000.0123456789abcdef';
type Seen = {authorization?: string; body: {type: string; at: number; id?: string; detail: Record<string, string>}};
const seen: Seen[] = [];
let server: http.Server;
let port: number;

before(async () => {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      seen.push({authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString())});
      response.end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as {port: number}).port;
});
after(() => { server.close(); });

// Asynchronous: the mock server lives in this process, which must keep serving while the hook runs.
async function hook(payload: object | string, env: NodeJS.ProcessEnv = {}): Promise<Seen | undefined> {
  const before = seen.length;
  const child = spawn('python3', [path.join(REPO, 'bin', 'mesh-event'), 'vibe'], {
    env: {PATH: process.env.PATH, MESH_PORT: String(port), MESH_SESSION_TOKEN: TOKEN, ...env}});
  const exit = new Promise<number | null>(resolve => child.on('close', resolve));
  child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  assert.equal(await exit, 0, 'a hook always exits successfully');
  return seen.length > before ? seen[seen.length - 1] : undefined;
}

const base = (hook_event_name: string, extra: object = {}) => ({hook_event_name, session_id: SESSION,
  transcript_path: '/x', cwd: '/work', parent_session_id: null, agent_name: 'accept-edits', ...extra});
const notification = (notification_type: string) => base('notification', {notification_type, message: 'm'});

describe('mesh-event vibe', () => {
  test('a prompt and the tools are work, and carry the conversation to resume', async () => {
    for (const name of ['pre_agent', 'pre_tool', 'post_tool']) {
      const event = await hook(base(name, name === 'pre_agent' ? {turn_id: 'turn-1', prompt: 'secret prompt text'} : {tool_name: 'bash'}));
      assert.equal(event?.authorization, `MeshSession ${TOKEN}`);
      assert.equal(event?.body.type, 'working');
      assert.equal(event?.body.detail.source, 'vibe');
      assert.equal(event?.body.detail.session, SESSION);
      assert.ok(!JSON.stringify(event?.body).includes('secret prompt text'), 'the prompt is never forwarded');
    }
  });

  test('the notifications give the idle, permission and question states', async () => {
    assert.equal((await hook(notification('turn_completed')))?.body.type, 'done');
    assert.equal((await hook(notification('approval_requested')))?.body.type, 'waiting_permission');
    assert.equal((await hook(notification('question_asked')))?.body.type, 'waiting_question');
    assert.equal((await hook(notification('turn_failed')))?.body.type, 'error');
    assert.equal((await hook(notification('something_new'))), undefined, 'an unknown notification is not a state');
  });

  test('a new session is idle, and a stop that is not a notification says nothing', async () => {
    assert.equal((await hook(base('session_start', {source: 'startup', model: 'm'})))?.body.type, 'done');
    assert.equal((await hook(base('post_agent'))), undefined);
    assert.equal((await hook(base('session_end'))), undefined);
  });

  test('a sub-agent never speaks for the terminal', async () => {
    assert.equal((await hook(base('pre_agent', {parent_session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}))), undefined);
    assert.equal((await hook({...notification('turn_completed'), parent_session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'})), undefined);
  });

  test('an id that is not a Vibe conversation id is not reported; no token or a bad port sends nothing', async () => {
    assert.equal((await hook({...base('pre_agent'), session_id: '../../x'}))?.body.detail.session, undefined);
    assert.equal((await hook(base('pre_agent'), {MESH_SESSION_TOKEN: ''})), undefined);
    assert.equal((await hook(base('pre_agent'), {MESH_PORT: '80:81'})), undefined);
  });

  test('garbage on standard input is silent and successful', async () => {
    assert.equal(await hook('not json'), undefined);
  });
});

describe('the hooks directory handed to Vibe', () => {
  const python = (code: string, home: string) => execFileSync(process.env.MESH_PYTHON || 'python3', ['-I', '-c',
    `import sys; sys.path.insert(0, ${JSON.stringify(REPO)})\n${code}`],
  // The project context hook (docs/agent-hooks.md) is off: these tests are about the state hooks, and
  // whether it is added depends on a work-read in the opam switch (tests/agent-hooks-golden.test.ts).
  {cwd: REPO, encoding: 'utf8', env: {PATH: process.env.PATH, HOME: home, MESH_PROJECT_HOOKS: '0'}}).trim();
  const make = (conf: string, id: string, command: string, home: string) => python(
    `import agentmcp; print(agentmcp.vibe_hooks_dir(${JSON.stringify(conf)}, ${JSON.stringify(id)}, ${JSON.stringify(command)}))`, home);
  const mode = (target: string) => fs.statSync(target).mode & 0o777;
  const tree = (root: string): string[] => fs.readdirSync(root, {withFileTypes: true}).flatMap(entry =>
    entry.isDirectory() ? [entry.name + '/', ...tree(path.join(root, entry.name)).map(inner => `${entry.name}/${inner}`)] : [entry.name]);

  test('is private to a launch, holds the five hook types and nothing else, read-only, rebuilt from scratch, and needs the hook program', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hooks-'));
    try {
      const program = path.join(scratch, 'my bin', 'mesh-event');
      fs.mkdirSync(path.dirname(program));
      fs.writeFileSync(program, '#!/bin/sh\n', {mode: 0o755});
      const conf = path.join(scratch, 'conf');
      const directory = make(conf, 'vibe-aaaaaaaa', program, scratch);
      assert.equal(directory, path.join(conf, 'mesh-vibe-hooks', 'vibe-aaaaaaaa'));
      assert.notEqual(make(conf, 'vibe-bbbbbbbb', program, scratch), directory, 'one directory per launch');
      const file = path.join(directory, '.vibe', 'hooks.toml');
      const text = fs.readFileSync(file, 'utf8');
      assert.deepEqual([...text.matchAll(/^type = "(\w+)"$/gm)].map(match => match[1]),
        ['session_start', 'pre_agent', 'pre_tool', 'post_tool', 'notification']);
      assert.ok(text.includes(`command = ${JSON.stringify(`'${program}' vibe`)}`), 'a path with a space is quoted');
      assert.ok(!/token|MESH_SESSION/i.test(text), 'no credential');
      assert.deepEqual(tree(directory), ['.vibe/', '.vibe/hooks.toml']);
      assert.equal(mode(path.join(conf, 'mesh-vibe-hooks')), 0o700);
      assert.equal(mode(directory), 0o500, 'the agent cannot add an AGENTS.md or a .agents directory');
      assert.equal(mode(path.dirname(file)), 0o500, 'nor .vibe/tools, plugins or agents');
      assert.equal(mode(file), 0o400);
      assert.throws(() => fs.writeFileSync(file, 'stale'), /EACCES/);
      assert.throws(() => fs.writeFileSync(path.join(directory, 'AGENTS.md'), 'planted'), /EACCES/);
      // A directory of the same launch id that something else filled is replaced, not reused.
      fs.chmodSync(directory, 0o700);
      fs.writeFileSync(path.join(directory, 'AGENTS.md'), 'planted');
      fs.chmodSync(directory, 0o500);
      assert.equal(make(conf, 'vibe-aaaaaaaa', program, scratch), directory);
      assert.deepEqual(tree(directory), ['.vibe/', '.vibe/hooks.toml']);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
      assert.equal(make(conf, 'vibe-cccccccc', path.join(scratch, 'absent'), scratch), 'None');
      assert.equal(fs.existsSync(path.join(conf, 'mesh-vibe-hooks', 'vibe-cccccccc')), false);
      assert.throws(() => make(conf, '../escape', program, scratch), /launch id/);
    } finally {
      execFileSync('chmod', ['-R', 'u+rwX', scratch]);
      fs.rmSync(scratch, {recursive: true, force: true});
    }
  });

  test('the root is created 0700 even with a permissive umask, and removal and the sweep delete read-only directories', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-hooks-'));
    try {
      const program = path.join(scratch, 'mesh-event');
      fs.writeFileSync(program, '#!/bin/sh\n', {mode: 0o755});
      const conf = path.join(scratch, 'a', 'b', 'conf');
      const root = path.join(conf, 'mesh-vibe-hooks');
      python(`import os, agentmcp; os.umask(0); agentmcp.vibe_hooks_dir(${JSON.stringify(conf)}, 'vibe-kept0000', ${JSON.stringify(program)}); `
        + `agentmcp.vibe_hooks_dir(${JSON.stringify(conf)}, 'vibe-gone0000', ${JSON.stringify(program)}); `
        + `agentmcp.vibe_hooks_dir(${JSON.stringify(conf)}, 'vibe-fresh000', ${JSON.stringify(program)})`, scratch);
      assert.equal(mode(root), 0o700);
      assert.equal(mode(conf), 0o700);
      fs.writeFileSync(path.join(root, 'stray-file'), 'x');
      fs.utimesSync(path.join(root, 'vibe-fresh000'), new Date(), new Date());
      const old = new Date(Date.now() - 3_600_000);
      for (const name of ['vibe-kept0000', 'vibe-gone0000', 'stray-file']) fs.utimesSync(path.join(root, name), old, old);
      const removed = python(`import agentmcp; print(agentmcp.purge_vibe_hooks(${JSON.stringify(conf)}, {'vibe-kept0000'}, 300))`, scratch);
      assert.equal(removed, '2', 'what no live session claims and is older than the grace period');
      assert.deepEqual(fs.readdirSync(root).sort(), ['vibe-fresh000', 'vibe-kept0000']);
      python(`import agentmcp; agentmcp.remove_vibe_hooks_dir(${JSON.stringify(path.join(root, 'vibe-kept0000'))})`, scratch);
      assert.deepEqual(fs.readdirSync(root), ['vibe-fresh000']);
      assert.equal(python(`import agentmcp; print(agentmcp.purge_vibe_hooks(${JSON.stringify(conf)}, set(), 0))`, scratch), '1');
      assert.deepEqual(fs.readdirSync(root), []);
      assert.equal(python(`import agentmcp; print(agentmcp.purge_vibe_hooks(${JSON.stringify(path.join(scratch, 'none'))}))`, scratch), '0');
    } finally {
      execFileSync('chmod', ['-R', 'u+rwX', scratch]);
      fs.rmSync(scratch, {recursive: true, force: true});
    }
  });
});
