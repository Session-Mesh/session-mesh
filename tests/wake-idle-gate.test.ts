// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A mail notice ("# Mesh: new message(s) waiting ...") ends with Enter. Typed while an agent shows
// an approval prompt, that Enter would answer it. The notice is therefore typed only when the
// agent is known to be idle at its prompt: its last hook event is a finished turn ("done") and no
// input has reached its terminal since.
// - the native PTY host refuses `notify_if` with
//   "not_idle" when input was queued at or after `idle_since`, the wake itself included;
// - the server, with a fake Claude whose hook events the test sends, keeps a message's notice
//   pending while no turn has finished, while a turn runs and after input, and types it once the
//   finished-turn event arrives.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import fs from 'node:fs';
import {fakeAgentShell} from './helpers/fake-agent.ts';
import os from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {approveWakeMail} from './codex-queue-wake-lib.ts';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import net from 'node:net';
import {ptyhostArgv} from './ptyhost-command.ts';
import {attach, encode, request, waitFor} from './ptyhost-wire-lib.ts';

const HOST_ARGV = ptyhostArgv();
const NOTICE = 'check mail.inbox';

const hosts: ChildProcess[] = [];
const scratches: string[] = [];
let mesh: Mesh | undefined;

after(async () => {
  for (const host of hosts) host.kill('SIGKILL');
  await mesh?.stop();
  for (const dir of scratches) fs.rmSync(dir, {recursive: true, force: true});
});

function startHost(env: NodeJS.ProcessEnv, socketPath: string): Promise<void> {
  hosts.push(spawn(HOST_ARGV[0], HOST_ARGV.slice(1), {cwd: REPO, env, stdio: 'ignore'}));
  return waitFor('ptyhost answering', 10000, () => request(socketPath, {op: 'list'}).then(() => true, () => false))
    .then(() => undefined);
}

const now = () => Date.now() / 1000;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('PTY host: notify_if requires idle evidence newer than the last input', () => {
  test('input at or after idle_since, the wake included, defers the notice', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-idle-host-'));
    scratches.push(scratch);
    const home = path.join(scratch, 'home');
    const runtime = path.join(scratch, 'run');
    fs.mkdirSync(home);
    fs.mkdirSync(runtime, {mode: 0o700});
    const shell = path.join(scratch, 'shell.sh');
    fs.writeFileSync(shell, '#!/bin/sh\nexec bash --noprofile --norc -i\n', {mode: 0o700});
    const socketPath = path.join(runtime, 'session-mesh', 'ptyhost.sock');
    await startHost({PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_RUNTIME_DIR: runtime, SHELL: shell, LANG: 'C'}, socketPath);

    assert.deepEqual(await request(socketPath, {op: 'new', name: 'agent', cwd: home, command: null}), {ok: true, name: 'agent'});
    const [session] = await request(socketPath, {op: 'list'}) as {name: string; created: number}[];
    const terminal = await attach(socketPath, 'agent');
    const beforeStart = now();
    await pause(50);
    assert.deepEqual(await request(socketPath, {op: 'start_if', name: 'agent', created: session.created,
      command: 'exec -a claude bash --noprofile --norc -i'}), {ok: true});
    await waitFor('the fake agent prompt', 10000, () => terminal.output().includes('claude-'));
    await pause(300);
    let serial = 0;
    const wake = (idleSince: number) => request(socketPath, {op: 'notify_if', name: 'agent', created: session.created,
      notification_id: `wake_idle_gate_${String(++serial).padStart(4, '0')}`, count: 1, through_seq: serial,
      agent: 'claude', idle_since: idleSince});

    assert.deepEqual(await wake(beforeStart), {ok: false, reason: 'not_idle'}, 'the typed command came after the idle evidence');
    const idle = now();
    await pause(50);
    assert.deepEqual(await wake(idle), {ok: true, accepted: true});
    await waitFor('the notice', 10000, () => terminal.output().includes(NOTICE));
    assert.doesNotMatch(terminal.output(), /\d+ message\(s\)/, 'the notice carries no digit');
    assert.deepEqual(await wake(idle), {ok: false, reason: 'not_idle'}, 'the notice itself is input: one per idle period');

    await pause(50);
    const idleAgain = now();
    await pause(50);
    terminal.send('D', Buffer.from('x'));
    await pause(200);
    assert.deepEqual(await wake(idleAgain), {ok: false, reason: 'not_idle'}, 'a keystroke after the idle evidence');
    terminal.send('D', Buffer.from('\x15'));   // erase the line before the next notice
    await pause(200);
    assert.deepEqual(await wake(now()), {ok: true, accepted: true});
    assert.equal('error' in (await request(socketPath, {op: 'notify_if', name: 'agent', created: session.created,
      notification_id: 'wake_idle_gate_none', count: 1, through_seq: 1, agent: 'claude'}) as object), true,
    'idle_since is required');
    terminal.close();
  });
});

// The notice's Enter follows its text after a short delay (WAKE_SUBMIT_DELAY, 250 ms). Input that
// reaches the session in that delay withdraws it and erases the notice's line (Ctrl-U) before the
// input; the server's `cancel_submit` (a new turn began) withdraws it and leaves the text unsent.
describe('PTY host: the Enter of a notice is withdrawn during its delay', () => {
  test('by input, and by cancel_submit', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-cancel-host-'));
    scratches.push(scratch);
    const home = path.join(scratch, 'home');
    const runtime = path.join(scratch, 'run');
    fs.mkdirSync(home);
    fs.mkdirSync(runtime, {mode: 0o700});
    const shell = path.join(scratch, 'shell.sh');
    fs.writeFileSync(shell, '#!/bin/sh\nexec bash --noprofile --norc -i\n', {mode: 0o700});
    const log = path.join(scratch, 'input.log');
    const socketPath = path.join(runtime, 'session-mesh', 'ptyhost.sock');
    await startHost({PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_RUNTIME_DIR: runtime, SHELL: shell, LANG: 'C'}, socketPath);

    assert.deepEqual(await request(socketPath, {op: 'new', name: 'agent', cwd: home, command: null}), {ok: true, name: 'agent'});
    const [session] = await request(socketPath, {op: 'list'}) as {name: string; created: number}[];
    const terminal = await attach(socketPath, 'agent');
    // A fake Claude that logs each line it reads: a line is logged only once Enter reached it.
    assert.deepEqual(await request(socketPath, {op: 'start_if', name: 'agent', created: session.created,
      command: `exec -a claude sh -c 'echo READY; while IFS= read -r line; do printf "%s\\n" "$line" >> ${log}; done'`}),
    {ok: true});
    await waitFor('the fake agent', 10000, () => terminal.output().includes('READY'));
    await pause(300);
    const lines = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    let serial = 0;
    const wake = () => request(socketPath, {op: 'notify_if', name: 'agent', created: session.created,
      notification_id: `wake_cancel_gate_${String(++serial).padStart(4, '0')}`, count: 1, through_seq: serial,
      agent: 'claude', idle_since: now()});

    assert.deepEqual(await wake(), {ok: true, accepted: true});
    terminal.send('D', Buffer.from('abc'));
    await pause(700);
    assert.deepEqual(lines(), [], 'input during the delay: no Enter after the notice');
    terminal.send('D', Buffer.from('\r'));
    await waitFor('the human Enter', 5000, () => lines().length === 1);
    assert.equal(lines()[0], 'abc', 'the notice line was erased (Ctrl-U) before the human input');

    await pause(100);
    assert.deepEqual(await wake(), {ok: true, accepted: true});
    assert.deepEqual(await request(socketPath, {op: 'cancel_submit', name: 'agent', created: session.created}),
      {ok: true, cancelled: true});
    await pause(700);
    assert.equal(lines().length, 1, 'cancel_submit: no Enter after the notice');
    assert.deepEqual(await request(socketPath, {op: 'cancel_submit', name: 'agent', created: session.created}),
      {ok: true, cancelled: false});
    assert.deepEqual(await request(socketPath, {op: 'cancel_submit', name: 'agent', created: session.created + 1}),
      {ok: false, reason: 'stale_incarnation'});
    assert.equal('error' in (await request(socketPath, {op: 'cancel_submit', name: 'agent'}) as object), true);

    // Without either, the Enter follows: one more line, the unsent notice included.
    terminal.send('D', Buffer.from('\x15'));   // erase the unsent notice
    await pause(200);
    assert.deepEqual(await wake(), {ok: true, accepted: true});
    await waitFor('the notice submitted', 5000, () => lines().length === 2);
    assert.match(lines()[1], /^# Mesh: new message\(s\) waiting; the user approved reading mail\. Please check mail\.inbox/);
    terminal.close();
  });

  // xterm sends focus reports, mouse reports and cursor-position replies on its own; the page
  // relays them as input. They are not typing: the Enter stays and no Ctrl-U is added. A fake
  // Claude in raw mode records every byte it receives, Enter and Ctrl-U included.
  test('terminal reports alone leave the Enter; a key among them withdraws it', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-reports-host-'));
    scratches.push(scratch);
    const home = path.join(scratch, 'home');
    const runtime = path.join(scratch, 'run');
    fs.mkdirSync(home);
    fs.mkdirSync(runtime, {mode: 0o700});
    const log = path.join(scratch, 'input.log');
    const socketPath = path.join(runtime, 'session-mesh', 'ptyhost.sock');
    await startHost({PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_RUNTIME_DIR: runtime, LANG: 'C'}, socketPath);
    assert.deepEqual(await request(socketPath, {op: 'new', name: 'agent', cwd: home, command: null}), {ok: true, name: 'agent'});
    const [session] = await request(socketPath, {op: 'list'}) as {name: string; created: number}[];
    const terminal = await attach(socketPath, 'agent');
    assert.deepEqual(await request(socketPath, {op: 'start_if', name: 'agent', created: session.created,
      command: `exec -a claude sh -c 'stty raw -echo; echo READY; cat > ${log}'`}), {ok: true});
    await waitFor('the fake agent', 10000, () => terminal.output().includes('READY'));
    await pause(300);
    const received = () => fs.existsSync(log) ? fs.readFileSync(log, 'latin1') : '';
    let serial = 0;
    const wake = () => request(socketPath, {op: 'notify_if', name: 'agent', created: session.created,
      notification_id: `wake_reports_gate_${String(++serial).padStart(4, '0')}`, count: 1, through_seq: serial,
      agent: 'claude', idle_since: now()});

    // Focus in and out, SGR mouse press and release, an X10 mouse report, a wheel event, a
    // cursor-position reply and a device-status reply, as separate frames and as one.
    const reports = ['\x1b[I', '\x1b[O', '\x1b[<0;10;5M\x1b[<0;10;5m', '\x1b[M !!', '\x1b[<65;3;4M',
      '\x1b[12;40R', '\x1b[0n'];
    const END = 'read authorized entries without asking again.';
    assert.deepEqual(await wake(), {ok: true, accepted: true});
    for (const report of reports) terminal.send('D', Buffer.from(report, 'latin1'));
    terminal.send('D', Buffer.from(reports.join(''), 'latin1'));
    await pause(700);
    const notice = received().slice(0, received().indexOf(END) + END.length);
    assert.equal(notice, '# Mesh: new message(s) waiting; the user approved reading mail. '
      + 'Please check mail.inbox and read authorized entries without asking again.');
    assert.doesNotMatch(notice, /\d/);
    const tail = received().slice(notice.length);
    assert.equal(tail.indexOf('\r'), tail.length - reports.join('').length * 2 - 1, JSON.stringify(tail));
    assert.equal(tail.endsWith('\r' + reports.join('') + reports.join('')), true, 'the Enter, then the reports unchanged');

    // A key, here Up, with or without a report around it, is typing: the Enter is withdrawn and
    // the line erased before the key.
    for (const typing of ['\x1b[A', '\x1b[I\x1b[A', 'y']) {
      const before = received().length;
      assert.deepEqual(await wake(), {ok: true, accepted: true});
      terminal.send('D', Buffer.from(typing, 'latin1'));
      await pause(700);
      const added = received().slice(before);
      assert.equal(added.endsWith(END + '\x15' + typing), true, `${JSON.stringify(typing)}: ${JSON.stringify(added)}`);
      assert.equal(added.includes('\r'), false, `${JSON.stringify(typing)} withdrew the Enter`);
    }
    terminal.close();
  });

  test('a huge integer idle_since is an invalid request, and the host keeps answering', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-huge-host-'));
    scratches.push(scratch);
    const home = path.join(scratch, 'home');
    const runtime = path.join(scratch, 'run');
    fs.mkdirSync(home);
    fs.mkdirSync(runtime, {mode: 0o700});
    const socketPath = path.join(runtime, 'session-mesh', 'ptyhost.sock');
    await startHost({PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, XDG_RUNTIME_DIR: runtime, LANG: 'C'}, socketPath);
    assert.deepEqual(await request(socketPath, {op: 'new', name: 'agent', cwd: home, command: null}), {ok: true, name: 'agent'});
    const [session] = await request(socketPath, {op: 'list'}) as {name: string; created: number}[];
    // JSON.stringify cannot write such a number: splice it into the text.
    const huge = '1' + '0'.repeat(400);
    const raw = (field: string) => JSON.parse(JSON.stringify({op: 'notify_if', name: 'agent', created: session.created,
      notification_id: 'wake_huge_number_0001', count: 1, through_seq: 1, agent: 'claude', idle_since: 1, [field]: '@'}));
    for (const field of ['idle_since', 'created']) {
      const text = JSON.stringify(raw(field)).replace('"@"', huge);
      const reply = await rawRequest(socketPath, text);
      assert.equal(typeof (reply as {error?: unknown}).error, 'string', `${field}: ${JSON.stringify(reply)}`);
    }
    assert.equal((await request(socketPath, {op: 'list'}) as unknown[]).length, 1);
  });
});

function rawRequest(socketPath: string, text: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let received = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(new Error('ptyhost did not answer')));
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('ptyhost closed the connection without an answer')));
    socket.on('connect', () => socket.write(encode('C', Buffer.from(text))));
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 5 || received.length < 5 + received.readUInt32BE(1)) return;
      socket.destroy();
      resolve(JSON.parse(received.subarray(5, 5 + received.readUInt32BE(1)).toString('utf8')));
    });
  });
}

describe('server: a fake Claude is woken only once it reports a finished turn', () => {
  type Agent = {name: string; dir: string; token: string; created: number};
  const agents: Record<string, Agent> = {};

  const ownerHeaders = () => ({Authorization: `Bearer ${mesh!.token()}`, Origin: mesh!.base, 'Content-Type': 'application/json'});
  const agentHeaders = (agent: Agent) => ({Authorization: `MeshSession ${agent.token}`, 'Content-Type': 'application/json'});
  const typed = (agent: Agent) => {
    const log = path.join(agent.dir, 'input.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  };
  const notices = (agent: Agent) => typed(agent).split('\n').filter(line => line.includes(NOTICE)).length;

  async function launch(name: string): Promise<Agent> {
    const dir = path.join(mesh!.home, name);
    fs.mkdirSync(dir);
    const response = await fetch(`${mesh!.base}/api/new`, {method: 'POST', headers: ownerHeaders(),
      body: JSON.stringify({preset: 'claude', cwd: dir, name})});
    assert.equal(response.status, 200, await response.clone().text());
    await waitFor(`fake claude ${name}`, 15000, () => fs.existsSync(path.join(dir, 'token')));
    const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
    return {name, dir, token, created: 0};
  }

  async function event(agent: Agent, type: string, at?: number): Promise<void> {
    const response = await fetch(`${mesh!.base}/api/event`, {method: 'POST', headers: agentHeaders(agent),
      body: JSON.stringify({type, detail: {source: 'claude'}, ...(at === undefined ? {} : {at})})});
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json() as {applied: boolean}).applied, true);
  }

  async function sendApproved(from: Agent, to: Agent, text: string): Promise<void> {
    const response = await fetch(`${mesh!.base}/api/agent-mail/@self/send`, {method: 'POST', headers: agentHeaders(from),
      body: JSON.stringify({target: to.name, target_created: to.created, kind: 'message', text})});
    assert.equal(response.status, 200, await response.clone().text());
    await approveWakeMail(mesh!.base, mesh!.token(), response);
  }

  test('no notice before a finished turn, during a turn or after input; one once idle', async () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
    scratches.push(bin);
    // Its name makes it "claude" in the foreground check; each line it reads is what was typed.
    fs.writeFileSync(path.join(bin, 'claude'), [
      '#!/bin/sh',
      // The server asks which version it is (an old one: the typed notice stays), with no side effect.
      'if [ "$1" = "--version" ]; then echo "2.1.200 (Claude Code)"; exit 0; fi',
      'printf "%s" "$MESH_SESSION_TOKEN" > ./token.tmp && mv ./token.tmp ./token',
      'while IFS= read -r line; do printf "%s\\n" "$line" >> ./input.log; done',
      '',
    ].join('\n'), {mode: 0o755});
    const PATH = `${bin}:${process.env.PATH}`;
    mesh = await startMesh('wake-idle-', {PATH});
    await startHost({PATH, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C', SHELL: fakeAgentShell(bin)},
      path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'));

    agents.sender = await launch('sender');
    agents.target = await launch('target');
    const peers = await (await fetch(`${mesh.base}/api/agent-mail/@self/peers`, {headers: agentHeaders(agents.sender)}))
      .json() as {peers: {id: string; created: number; agent: string}[]};
    const peer = peers.peers.find(item => item.id === 'target');
    assert.equal(peer?.agent, 'claude');
    agents.target.created = peer!.created;
    const {sender, target} = agents;

    await sendApproved(sender, target, 'first');
    await pause(2500);
    assert.equal(notices(target), 0, 'no hook event yet: the agent is not known to be idle');

    await event(target, 'working');
    await pause(2000);
    assert.equal(notices(target), 0, 'a turn is running');

    // A finished turn, but input reached the terminal after it: a new turn may have started.
    const finishedBeforeInput = now();
    await pause(100);
    const terminal = await attach(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock'), 'target');
    terminal.send('D', Buffer.from('human prompt\r'));
    await waitFor('the human line', 5000, () => typed(target).includes('human prompt'));
    terminal.close();
    await event(target, 'done', finishedBeforeInput);
    await pause(2500);
    assert.equal(notices(target), 0, 'input after the finished turn');

    await event(target, 'done');
    await waitFor('the notice once idle', 10000, () => notices(target) === 1);
    assert.doesNotMatch(typed(target), /\d+ message\(s\)/);

    // The notice was input too: a new message waits for the next finished turn.
    await sendApproved(sender, target, 'second');
    await pause(2500);
    assert.equal(notices(target), 1, 'no second notice in the same idle period');
    await event(target, 'done');
    await waitFor('a notice after the next finished turn', 10000, () => notices(target) === 2);
  });

  // A hook may date its event up to a minute ahead; it still never outranks a later real one.
  test('a finished turn dated in the future does not hide the next turn', async () => {
    const {sender, target} = agents;
    await event(target, 'done', now() + 59);
    await event(target, 'waiting_permission');
    await sendApproved(sender, target, 'third');
    await pause(2500);
    assert.equal(notices(target), 2, 'an approval prompt is showing: no notice');
    await event(target, 'done');
    await waitFor('the notice once idle again', 10000, () => notices(target) === 3);
  });

  test('a turn that begins while a notice waits for its Enter withdraws that Enter', async () => {
    const {sender, target} = agents;
    await sendApproved(sender, target, 'fourth');   // the last notice was input: deferred until a finished turn
    await pause(500);
    const terminal = await attach(path.join(mesh!.home, 'run', 'session-mesh', 'ptyhost.sock'), 'target');
    await pause(200);
    const shown = () => terminal.output().split(NOTICE).length - 1;
    const before = shown();
    await event(target, 'done');
    // The notice text is echoed as soon as it is typed; its Enter follows 250 ms later.
    await waitFor('the notice text', 10000, () => shown() > before);
    await event(target, 'working');
    await pause(1000);
    assert.equal(notices(target), 3, 'the Enter was withdrawn: the notice was not submitted');
    terminal.close();
  });

  // The dispatcher reads the finished turn, then waits for the mailbox lock before the notice
  // reaches the PTY host. A turn that begins during that wait finds no Enter to withdraw yet;
  // the server compares the event generation again once the notice is typed and withdraws it.
  test('a turn that begins while the dispatcher waits for the mailbox lock withdraws the Enter', async () => {
    const {sender, target} = agents;
    await event(target, 'working');
    await sendApproved(sender, target, 'fifth');
    await pause(500);
    const terminal = await attach(path.join(mesh!.home, 'run', 'session-mesh', 'ptyhost.sock'), 'target');
    await pause(200);
    const shown = () => terminal.output().split(NOTICE).length - 1;
    const before = shown();
    const submitted = notices(target);
    // Hold the agent-mail lock as another process would.
    const holder = spawn('flock', [path.join(mesh!.confDir, 'agent-mail.json.lock'), '-c', 'echo held; read line'],
      {stdio: ['pipe', 'pipe', 'inherit']});
    let held = '';
    holder.stdout!.on('data', chunk => { held += chunk; });
    await waitFor('the lock held', 5000, () => held.includes('held'));
    await event(target, 'done');
    await pause(300);
    await event(target, 'working');
    await pause(1700);
    holder.stdin!.end('\n');
    await new Promise(resolve => holder.once('exit', resolve));
    await waitFor('the notice text', 10000, () => shown() > before);
    await pause(1000);
    assert.equal(notices(target), submitted, 'the notice was submitted during the new turn');
    terminal.close();
  });
});
