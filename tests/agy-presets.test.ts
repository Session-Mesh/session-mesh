// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Antigravity (agy) in the mesh without a model: a fake `agy` on PATH records its argv, its environment and what
// is typed into it, and the real hook command of the Mesh plugin (`bin/mesh-event agy <Event>`) reports to a real
// server and PTY host, fed with the payloads documented for agy hooks.
// Covered: launch from "+ New" (bare command, token only in the environment), the state and conversation the
// hooks report, no wake notice typed into agy (kept in the inbox until a real agy shows its Stop hook is silent
// during a permission prompt), a nested agent that inherits a session's token changing nothing (an agy inside a
// Claude session, a Claude or a second agy conversation inside an agy session), and the restore of the
// conversation after a PTY host restart with `--conversation`.
import assert from 'node:assert/strict';
import {type ChildProcess, spawnSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {nativePtyhost} from './helpers/native-ptyhost.ts';
import {fakeAgentPrologue, fakeAgentShell} from './helpers/fake-agent.ts';

const CONVERSATION = '0b9a1c2e-1111-4222-8333-444455556666';
const MARKER = 'AGY-TEST-CREDENTIAL';
const QUIET = 4;
let mesh: Mesh;
let fakes: string;

let host: ChildProcess | undefined;
let pathEnv: string;
const log = (file: string) => path.join(fakes, file);
const lines = (file: string): string[] =>
  fs.existsSync(log(file)) ? fs.readFileSync(log(file), 'utf8').split('\n').filter(Boolean) : [];

// The native host named by MESH_PTYHOST_CMD (nativePtyhost fails with a clear message when it is not set).

function startHost(): ChildProcess {
  const argv = nativePtyhost();
  return spawn(argv[0], argv.slice(1), {
    cwd: REPO, stdio: 'ignore',
    env: {PATH: pathEnv, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C', SHELL: path.join(fakes, 'plain-bash')}});
}

async function until<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  fakes = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-agy-'));
  fakeAgentShell(fakes);
  const bin = path.join(fakes, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'agy'), `${fakeAgentPrologue('agy')}printf 'argv:%s\\n' "$*" >> '${log('argv.log')}'
env | grep -c '^MESH_SESSION_TOKEN=' >> '${log('tokenpresent.log')}'
printf '%s\\n' "$MESH_SESSION_TOKEN" >> '${log('token.log')}'
printf '%s\\n' "$MESH_SESSION" >> '${log('session.log')}'
env | grep -E '^(ANTIGRAVITY|AGY)_' >> '${log('agyenv.log')}'
# While the file chatter-<session> exists, print a line twice a second (a model call, a long command).
main=$$
( while kill -0 "$main" 2>/dev/null; do
    if [ -e '${log('chatter-')}'"$MESH_SESSION" ]; then printf 'working...\\n'; fi
    sleep 0.5
  done ) &
while IFS= read -r line; do printf '%s\\n' "$line" >> '${log('input.log')}'; done
`, {mode: 0o755});
  fs.writeFileSync(path.join(bin, 'claude'), `${fakeAgentPrologue('claude')}printf '%s\\n' "$MESH_SESSION_TOKEN" >> '${log('claude-token.log')}'
printf '%s\\n' "$MESH_SESSION" >> '${log('claude-session.log')}'
while IFS= read -r line; do printf '%s\\n' "$line" >> '${log('claude-input.log')}'; done
`, {mode: 0o755});
  pathEnv = `${bin}:${process.env.PATH}`;
  mesh = await startMesh('agy-presets-', {PATH: pathEnv, GEMINI_API_KEY: MARKER, MESH_AGY_QUIET_SECONDS: String(QUIET)});
  host = startHost();
  await until('the PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
});

after(async () => {
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (fakes) fs.rmSync(fakes, {recursive: true, force: true});
});

const headers = () => ({Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'});
const post = (route: string, body: unknown) =>
  fetch(`${mesh.base}${route}`, {method: 'POST', headers: headers(), body: JSON.stringify(body)});

type Listed = {mesh: {id: string; known_agent: string | null; agent: {type: string; status?: string; session_id?: string} | null}[]};
async function listing(): Promise<Listed> {
  return await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as Listed;
}
const agentOf = async (name: string) => (await listing()).mesh.find(item => item.id === name)?.agent;

async function launch(name: string): Promise<void> {
  // A fake agy restored by an earlier test may still write its own line after this snapshot: wait for this
  // session's own line, not for any growth of the log.
  const before = lines('session.log').length;
  const response = await post('/api/new', {preset: 'agy', cwd: mesh.home, name});
  assert.equal(response.status, 200, await response.clone().text());
  await until(`the fake agy of ${name}`, () => lines('session.log').slice(before).includes(name));
}

/** What a hook runner does: run the hook command with the terminal's environment, the payload on stdin. */
function runHook(token: string, args: string[], payload: unknown, env: NodeJS.ProcessEnv = {}): string {
  const run = spawnSync(path.join(REPO, 'bin', 'mesh-event'), args, {
    input: JSON.stringify(payload), encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: mesh.home, MESH_PORT: String(mesh.port), MESH_SESSION_TOKEN: token, ...env}});
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function hook(name: string, event: string, payload: unknown, env: NodeJS.ProcessEnv = {}): string {
  const index = lines('session.log').lastIndexOf(name);
  assert.ok(index >= 0, `no launch recorded for ${name}`);
  return runHook(lines('token.log')[index], ['agy', event], payload, env);
}

/** An event posted straight to /api/event with the session's token, as a hook that names no source would. */
async function rawEvent(token: string, body: unknown): Promise<{applied: boolean; reason?: string}> {
  const response = await fetch(`${mesh.base}/api/event`, {method: 'POST', body: JSON.stringify(body),
    headers: {Authorization: `MeshSession ${token}`, 'Content-Type': 'application/json'}});
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as {applied: boolean; reason?: string};
}

/** A hook of Claude Code (or of an agy it started) run with the token of the Claude session ``name``. */
function claudeToken(name: string): string {
  const index = lines('claude-session.log').lastIndexOf(name);
  assert.ok(index >= 0, `no Claude launch recorded for ${name}`);
  return lines('claude-token.log')[index];
}

const start = (invocationNum: number, conversationId = CONVERSATION) => ({conversationId, invocationNum, initialNumSteps: 0});
// A conversation no other session of this suite reports: the identity registry gives one conversation to one
// live session, and the restored agy-main holds CONVERSATION when agy-term reports.
const TERM_CONVERSATION = '0b9a1c2e-1111-4222-8333-777788889999';
const stop = (fullyIdle: boolean, terminationReason = 'model_stop') =>
  ({conversationId: CONVERSATION, executionNum: 1, terminationReason, fullyIdle});

describe('Antigravity preset', () => {
  test('launches bare, as the agent agy, with the token in the environment only', async () => {
    await launch('agy-main');
    assert.equal(lines('argv.log')[0], 'argv:');
    assert.equal(lines('tokenpresent.log')[0], '1');
    assert.match(lines('token.log')[0], /^ms1\./);
    const mine = (await listing()).mesh.find(item => item.id === 'agy-main');
    assert.equal(mine?.known_agent, 'agy');
    assert.ok(!fs.readFileSync(log('argv.log'), 'utf8').includes(MARKER));
  });

  test('the hooks report busy, then the end of the turn, with the conversation', async () => {
    hook('agy-main', 'PreInvocation', start(1));
    await until('a working state', async () => (await agentOf('agy-main'))?.status === 'busy');
    hook('agy-main', 'Stop', stop(false));
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal((await agentOf('agy-main'))?.status, 'busy', 'a Stop with work still running is not the end');
    hook('agy-main', 'Stop', stop(true));
    const idle = await until('an idle state', async () => {
      const agent = await agentOf('agy-main');
      return agent?.status === 'idle' ? agent : undefined;
    });
    assert.equal(idle.session_id, CONVERSATION);
    assert.equal(idle.type, 'agy');
  });

  test('a conversation id that could be an option is ignored', async () => {
    await launch('agy-odd');
    hook('agy-odd', 'PreInvocation', {...start(1), conversationId: '--dangerously-skip-permissions'});
    await until('a working state', async () => (await agentOf('agy-odd'))?.status === 'busy');
    assert.equal((await agentOf('agy-odd'))?.session_id, undefined);
  });

  test('the hook answers agy in the form it expects, with or without a token, and always succeeds', async () => {
    assert.deepEqual(JSON.parse(hook('agy-main', 'Stop', stop(true))), {decision: 'allow'});
    assert.deepEqual(JSON.parse(hook('agy-main', 'PreInvocation', start(2))), {});
    assert.deepEqual(JSON.parse(hook('agy-main', 'Stop', stop(true), {MESH_SESSION_TOKEN: ''})), {decision: 'allow'});
    assert.equal(hook('agy-main', 'Stop', 'not an object'), '{"decision":"allow"}\n');
    hook('agy-main', 'Stop', stop(true));
    await until('idle again', async () => (await agentOf('agy-main'))?.status === 'idle');
  });

  test('no wake notice is typed into agy, even after a finished turn: the message stays in the inbox', async () => {
    await launch('agy-peer');
    const peerOf = async (name: string) => (await (await fetch(`${mesh.base}/api/agent-mail/overview`, {
      headers: {Origin: mesh.base, Cookie: `mesh_auth=${await ownerCookie()}`}})).json() as
      {sessions: {identity: {id: string; created: number}}[]}).sessions.find(item => item.identity.id === name)!.identity;
    const created = (await peerOf('agy-main')).created;
    hook('agy-main', 'PreInvocation', start(3));
    await until('working', async () => (await agentOf('agy-main'))?.status === 'busy');
    const peerToken = lines('token.log')[lines('session.log').lastIndexOf('agy-peer')];
    const sent = await fetch(`${mesh.base}/api/agent-mail/@self/send`, {method: 'POST', body: JSON.stringify({
      target: 'agy-main', target_created: created, kind: 'message', text: 'hello'}),
    headers: {Authorization: `MeshSession ${peerToken}`, 'Content-Type': 'application/json'}});
    assert.equal(sent.status, 200, await sent.clone().text());
    hook('agy-main', 'Stop', stop(true));
    await until('idle', async () => (await agentOf('agy-main'))?.status === 'idle');
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.deepEqual(lines('input.log'), [], 'agy is not in the wake presets: nothing is typed, permission prompt or not');
    const token = lines('token.log')[lines('session.log').lastIndexOf('agy-main')];
    const inbox = await (await fetch(`${mesh.base}/api/agent-mail/@self/inbox`, {
      headers: {Authorization: `MeshSession ${token}`}})).json() as {messages?: unknown[]};
    assert.equal(inbox.messages?.length, 1, 'the message waits in the inbox');
  });

  test('an agy started inside a Claude session reports under its token without changing it', async () => {
    const claudeDir = path.join(mesh.home, 'claude-dir');
    fs.mkdirSync(claudeDir);
    const response = await post('/api/new', {preset: 'claude', cwd: claudeDir, name: 'claude-main'});
    assert.equal(response.status, 200, await response.clone().text());
    await until('the fake claude', () => lines('claude-session.log').includes('claude-main'));
    const token = claudeToken('claude-main');
    const hookOf = async () => ((await listing()).mesh as unknown as {id: string; hook: {type: string} | null}[])
      .find(item => item.id === 'claude-main')?.hook?.type;
    runHook(token, ['claude'], {hook_event_name: 'UserPromptSubmit', prompt_id: 'p1'});
    await until('the working state of Claude', async () => (await hookOf()) === 'working');
    // `agy -p` run by Claude: the plugin is global, so its hooks inherit MESH_SESSION_TOKEN.
    runHook(token, ['agy', 'PreInvocation'], start(1));
    runHook(token, ['agy', 'Stop'], stop(true));
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(await hookOf(), 'working', 'the nested agy\'s finished turn did not open the idle gate');
    // An event that names no source says nothing of who sent it: refused in a session whose agent is known.
    for (const body of [{type: 'done'}, {type: 'done', detail: {}}]) {
      assert.deepEqual(await rawEvent(token, body), {ok: true, applied: false, reason: 'foreign_source'});
    }
    assert.equal(await hookOf(), 'working', 'an event without a source did not open the idle gate');
    runHook(token, ['claude'], {hook_event_name: 'Stop', prompt_id: 'p1', background_tasks: []});
    await until('the Claude finished turn', async () => (await hookOf()) === 'done');
  });

  test('a Claude or a second conversation started inside an agy session changes nothing of it', async () => {
    await launch('agy-nest');
    const index = lines('session.log').lastIndexOf('agy-nest');
    const token = lines('token.log')[index];
    const other = '9f8e7d6c-5555-4666-8777-888899990000';
    hook('agy-nest', 'PreInvocation', start(1));
    await until('working', async () => (await agentOf('agy-nest'))?.status === 'busy');
    assert.equal((await agentOf('agy-nest'))?.session_id, CONVERSATION);
    // A nested agy: another conversation, or none at all once the session's own is known.
    runHook(token, ['agy', 'Stop'], {...stop(true), conversationId: other});
    runHook(token, ['agy', 'Stop'], {executionNum: 1, terminationReason: 'model_stop', fullyIdle: true});
    // A nested Claude Code: another agent's hook.
    runHook(token, ['claude'], {hook_event_name: 'Stop', prompt_id: 'p', background_tasks: []});
    assert.equal((await rawEvent(token, {type: 'done', detail: {session: CONVERSATION}})).reason, 'foreign_source');
    await new Promise(resolve => setTimeout(resolve, 600));
    const agent = await agentOf('agy-nest');
    assert.equal(agent?.status, 'busy', 'no foreign finished turn');
    assert.equal(agent?.session_id, CONVERSATION, 'the conversation of the session is not overwritten');
    hook('agy-nest', 'Stop', stop(true));
    await until('the session\'s own end of turn', async () => (await agentOf('agy-nest'))?.status === 'idle');
  });

  // Observed with a signed-in agy: a permission prompt sends no Stop, and neither does a refused or cancelled one,
  // after which agy is back at its input line. The last report stays "working"; the silence of the terminal
  // since it is the only sign left.
  test('a turn with no Stop and a silent terminal shows as waiting for you, until agy reports again', async () => {
    await launch('agy-quiet');
    hook('agy-quiet', 'PreInvocation', start(1));
    await until('working', async () => (await agentOf('agy-quiet'))?.status === 'busy');
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal((await agentOf('agy-quiet'))?.status, 'busy', 'not yet silent for long enough');
    const waiting = await until('waiting after the silence', async () => {
      const agent = await agentOf('agy-quiet');
      return agent?.status === 'waiting' ? agent : undefined;
    });
    assert.equal(waiting.session_id, CONVERSATION);
    hook('agy-quiet', 'PreInvocation', start(2));
    assert.equal((await until('working again', async () => {
      const agent = await agentOf('agy-quiet');
      return agent?.status === 'busy' ? agent : undefined;
    })).status, 'busy', 'a new report starts the silence over');
    hook('agy-quiet', 'Stop', stop(true));
    await until('idle', async () => (await agentOf('agy-quiet'))?.status === 'idle');
    await new Promise(resolve => setTimeout(resolve, (QUIET + 1) * 1000));
    assert.equal((await agentOf('agy-quiet'))?.status, 'idle', 'a finished turn never turns into waiting');
  });

  test('a terminal that keeps printing is not waiting, however long ago the last report was', async () => {
    await launch('agy-chatty');
    hook('agy-chatty', 'PreInvocation', start(1));
    const chatter = log('chatter-agy-chatty');
    fs.writeFileSync(chatter, '');
    try {
      await until('working', async () => (await agentOf('agy-chatty'))?.status === 'busy');
      for (let second = 0; second < QUIET + 3; second += 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        assert.equal((await agentOf('agy-chatty'))?.status, 'busy', 'the output restarts the silence');
      }
    } finally {
      fs.rmSync(chatter, {force: true});
    }
    await until('waiting once the output stops', async () => (await agentOf('agy-chatty'))?.status === 'waiting');
  });

  test('after a PTY host restart the conversation is restored with --conversation', async () => {
    assert.equal((await agentOf('agy-main'))?.session_id, CONVERSATION);
    host?.kill('SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 500));
    fs.rmSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), {force: true});
    host = startHost();
    await until('the new PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
    const restorable = await until('the lost session offered', async () => {
      const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as
        {restorable: {name: string; resumable: boolean; agent: string}[]};
      return data.restorable.find(item => item.name === 'agy-main');
    });
    assert.deepEqual([restorable.agent, restorable.resumable], ['agy', true]);
    const before = lines('argv.log').length;
    const restored = await post('/api/restore', {names: ['agy-main']});
    assert.equal(restored.status, 200, await restored.clone().text());
    await until('the restored agy', () => lines('argv.log').length > before);
    assert.equal(lines('argv.log')[before], `argv:--conversation ${CONVERSATION}`);
  });

  // A systemd stop sends SIGTERM to the PTY host: the sessions die with it, and the conversation the hook
  // reported must still be what the restore resumes.
  test('after a PTY host stopped with SIGTERM the conversation is restored too', async () => {
    await launch('agy-term');
    hook('agy-term', 'PreInvocation', start(1, TERM_CONVERSATION));
    await until('the conversation', async () => (await agentOf('agy-term'))?.session_id === TERM_CONVERSATION);
    // Listings with no page open (the snapshot loop, the watcher, an action) take the hook reports too: one of
    // them, here a request that finds no such process, must not record the session without its conversation.
    const adopt = await post('/api/adopt', {pid: 2147483000, mode: 'restart'});
    assert.equal(adopt.status, 404);
    const stopped = new Promise(resolve => host!.once('exit', resolve));
    host?.kill('SIGTERM');
    await stopped;
    // The server keeps listing while the host goes down and after.
    await new Promise(resolve => setTimeout(resolve, 2500));
    fs.rmSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), {force: true});
    host = startHost();
    await until('the new PTY host', () => fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')));
    const restorable = await until('the lost session offered', async () => {
      const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: headers()})).json() as
        {restorable: {name: string; resumable: boolean; agent: string}[]};
      return data.restorable.find(item => item.name === 'agy-term');
    });
    assert.deepEqual([restorable.agent, restorable.resumable], ['agy', true]);
  });
});

async function ownerCookie(): Promise<string> {
  const response = await fetch(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, {redirect: 'manual'});
  const cookie = response.headers.getSetCookie().find(item => item.startsWith('mesh_auth='));
  assert.ok(cookie, 'the owner cookie');
  return cookie.split(';')[0].slice('mesh_auth='.length);
}
