// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A Codex session whose conversation is known exactly is woken with `codex queue --thread <uuid>`,
// never by typing, and only when the owner turned the wake on (MESH_CODEX_QUEUE_WAKE=1).
// The rig (a real server, the native PTY host, a fake codex) is in codex-queue-wake-lib.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {REPO} from './mesh-server-lib.ts';
import {type Agent, CANARIES, NOTICE_TEXT, Rig, pause} from './codex-queue-wake-lib.ts';
import {waitFor} from './ptyhost-wire-lib.ts';

const rigs: Rig[] = [];
after(async () => { for (const rig of rigs) await rig.stop(); });

async function pair(rig: Rig, names: [string, string]): Promise<{sender: Agent; target: Agent}> {
  const sender = await rig.launch(names[0]);
  const target = await rig.launch(names[1]);
  await rig.learnCreated(sender, target);
  return {sender, target};
}

describe('server: a Codex woken with codex queue', () => {
  const rig = new Rig();
  rigs.push(rig);
  const agents: Record<string, Agent> = {};

  test('setup: a real server, a real PTY host, a fake codex', async () => {
    await rig.start('cqw-');
    Object.assign(agents, await pair(rig, ['sender', 'target']));
  });

  test('an exact conversation: one codex queue by argv, fixed digit-free text, no secret, nothing typed', async () => {
    const {sender, target} = agents;
    await rig.send(sender, target, 'SECRET body 12345');
    await waitFor('the codex queue call', 15000, () => rig.forTarget(target).length === 1);
    await pause(3500);                           // several dispatch rounds: still one
    const [call] = rig.forTarget(target);
    assert.equal(rig.forTarget(target).length, 1);
    assert.deepEqual(call.argv, ['queue', '--thread', target.uuid, '--message', NOTICE_TEXT]);
    assert.doesNotMatch(NOTICE_TEXT, /\d/);
    assert.equal(call.cwd, '/');
    const everything = JSON.stringify(call);
    for (const secret of [target.token, sender.token, ...Object.values(CANARIES)]) {
      assert.equal(everything.includes(secret), false, 'no token or secret in argv or environment');
    }
    assert.equal(everything.includes('SECRET body'), false, 'the message text is never sent');
    assert.equal(rig.typed(target), 0, 'nothing is typed in the terminal');
    assert.equal(await rig.lookAtInbox(target), 1, 'the message waits unread in the inbox');
    assert.equal(await rig.flagged(target), false);
  });

  test('the environment is the allow-list: no MESH_* name (MESH_RUNTIME_DIR, MESH_CANARY), no SSH_AUTH_SOCK, no EDITOR', () => {
    // The server's own clean environment keeps MESH_RUNTIME_DIR, SSH_AUTH_SOCK, SHELL, EDITOR for the sessions' shells;
    // `codex queue` talks to the Codex of CODEX_HOME / XDG_RUNTIME_DIR and needs none of them.
    const [call] = rig.forTarget(agents.target);
    assert.deepEqual(Object.keys(call.env).filter(key => /^(MESH_|SSH_|EDITOR|VISUAL|SHELL|DISPLAY|WAYLAND|DBUS)/.test(key)), []);
    assert.ok(Object.keys(call.env).includes('PATH'));
    assert.ok(Object.keys(call.env).includes('HOME'));
  });

  test('a second notification gets its own single call', async () => {
    const {sender, target} = agents;
    await rig.send(sender, target, 'second');
    await waitFor('the second call', 15000, () => rig.forTarget(target).length === 2);
    await pause(2500);
    assert.equal(rig.forTarget(target).length, 2);
  });

  for (const [label, behaviour] of [['a failing exit', 'fail'], ['an ambiguous name answer', 'ambiguous'],
    ['a timeout', 'timeout'], ['an enormous output', 'huge']] as const) {
    test(`${label}: sent once, never replayed, shown as unconfirmed, cleared by a look at the inbox`, async () => {
      const failing = await rig.launch(`failing-${behaviour}`);
      await rig.learnCreated(agents.sender, failing);
      rig.mode(behaviour);
      await rig.send(agents.sender, failing, 'x');
      await waitFor('the call', 15000, () => rig.forTarget(failing).length === 1);
      await waitFor('the unconfirmed mark', 15000, () => rig.flagged(failing));
      await pause(3500);
      assert.equal(rig.forTarget(failing).length, 1, 'no replay after an ambiguous outcome');
      assert.equal(rig.typed(failing), 0);
      assert.equal(await rig.lookAtInbox(failing), 1);
      assert.equal(await rig.flagged(failing), false, 'the look clears the mark');
      await pause(2500);
      assert.equal(rig.forTarget(failing).length, 1, 'and still no second send');
      rig.mode('ok');
    });
  }

  test('after an ambiguous outcome and a look at the inbox, a new message wakes again (nothing re-run for the old one)', async () => {
    const stuck = await rig.launch('stuck-then-fine');
    await rig.learnCreated(agents.sender, stuck);
    rig.mode('fail');
    await rig.send(agents.sender, stuck, 'first');
    await waitFor('the failed call', 15000, () => rig.forTarget(stuck).length === 1);
    await waitFor('the unconfirmed mark', 15000, () => rig.flagged(stuck));
    assert.equal(await rig.lookAtInbox(stuck), 1);
    await waitFor('the mark cleared', 15000, async () => !(await rig.flagged(stuck)));
    await pause(1500);
    assert.equal(rig.forTarget(stuck).length, 1, 'the look re-runs nothing for the old notification');
    rig.mode('ok');
    await rig.send(agents.sender, stuck, 'second');
    await waitFor('a call for the new message', 15000, () => rig.forTarget(stuck).length === 2);
    await pause(2500);
    assert.equal(rig.forTarget(stuck).length, 2);
    assert.equal(await rig.flagged(stuck), false);
  });

  test('the attempts are recorded in a private file, with no text and no secret', () => {
    const file = path.join(rig.confDir, 'codex-queue-wakes.json');
    assert.equal(fs.statSync(file).mode & 0o077, 0);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes(NOTICE_TEXT), false);
    assert.match(text, /"state":"queued"/);
  });

  test('an inexact identity never wakes: the rollout is only a guess (cwd_unique), never a name', async () => {
    const guessed = await rig.launch('guessed', true);
    await rig.learnCreated(agents.sender, guessed);
    const before = rig.calls().length;
    await rig.send(agents.sender, guessed, 'to a guess');
    await pause(4000);
    assert.equal(rig.calls().length, before, 'no codex queue for a conversation that is not exact');
    assert.equal(rig.typed(guessed), 0);
    assert.equal(await rig.lookAtInbox(guessed), 1);
  });

  test('no file is left in the repository', () => {
    assert.equal(fs.existsSync(path.join(REPO, 'token')), false);
  });
});

describe('server: the attempts kept are bounded without ever replaying one', () => {
  test('at the limit only a settled attempt is forgotten: a wake in doubt is never run a second time', async () => {
    const rig = new Rig();
    rigs.push(rig);
    await rig.start('cqw-cap-', {env: {MESH_CODEX_QUEUE_MAX_TRACKED: '2'}});
    const sender = await rig.launch('sender');
    const [x, y, z] = [await rig.launch('x'), await rig.launch('y'), await rig.launch('z')];
    for (const agent of [x, y, z]) await rig.learnCreated(sender, agent);
    rig.mode('fail');
    await rig.send(sender, x, 'one');
    await waitFor('the call for x', 15000, () => rig.forTarget(x).length === 1);
    await rig.send(sender, y, 'two');
    await waitFor('the call for y', 15000, () => rig.forTarget(y).length === 1);
    await waitFor('both in doubt', 15000, async () => (await rig.flagged(x)) && (await rig.flagged(y)));
    rig.mode('ok');
    await rig.send(sender, z, 'three');
    await waitFor('z withheld, shown', 15000, () => rig.flagged(z));
    await pause(3000);
    assert.equal(rig.forTarget(z).length, 0, 'no room: nothing is run, no record is dropped');
    assert.equal(rig.forTarget(x).length, 1, 'x is not replayed');
    assert.equal(rig.forTarget(y).length, 1, 'y is not replayed');
    assert.match(rig.serverOutput(), /codex queue wake: 2 attempts in doubt/);
    assert.equal(await rig.lookAtInbox(x), 1);       // x settles; its record can be forgotten
    await waitFor('z woken once room exists', 30000, () => rig.forTarget(z).length === 1);
    await waitFor('z no longer withheld', 15000, async () => !(await rig.flagged(z)));
    await pause(3000);
    assert.equal(rig.forTarget(z).length, 1);
    assert.equal(rig.forTarget(x).length, 1, 'x is still not replayed');
    assert.equal(rig.forTarget(y).length, 1, 'nor y');
  });
});

describe('server: a runaway codex queue is killed when it passes the output limit, not at the time limit', () => {
  test('an endless output ends the process at once although the time limit is 20 s', async () => {
    const rig = new Rig();
    rigs.push(rig);
    await rig.start('cqw-excess-', {env: {MESH_CODEX_QUEUE_TIMEOUT_SECONDS: '20'}});
    const {sender, target} = await pair(rig, ['sender', 'target']);
    rig.mode('endless');
    const started = Date.now();
    await rig.send(sender, target, 'x');
    await waitFor('the call', 15000, () => rig.forTarget(target).length === 1);
    const [call] = rig.forTarget(target);
    const alive = () => { try { process.kill(call.pid, 0); return true; } catch { return false; } };
    await waitFor('the process group is killed', 15000, () => !alive());
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 8000, `the process ran ${elapsed} ms: it was left to the 20 s limit`);
    await waitFor('the unconfirmed mark', 15000, () => rig.flagged(target));
    assert.equal(rig.forTarget(target).length, 1);
  });
});

describe('server: a damaged state file is logged, set aside and never read as "nothing was run"', () => {
  test('sessions alive at the damage stay unconfirmed, the file is kept, new sessions are woken', async () => {
    const rig = new Rig();
    rigs.push(rig);
    await rig.start('cqw-damaged-');
    const {sender, target} = await pair(rig, ['sender', 'target']);
    await rig.send(sender, target, 'first');
    await waitFor('the first call', 15000, () => rig.forTarget(target).length === 1);
    const file = path.join(rig.confDir, 'codex-queue-wakes.json');
    await waitFor('the attempt is recorded', 10000, () => fs.existsSync(file));
    await rig.restart(where => fs.writeFileSync(path.join(where.confDir, 'codex-queue-wakes.json'), '{"entries": [torn'));
    const kept = fs.readdirSync(rig.confDir).filter(name => name.startsWith('codex-queue-wakes.json.damaged-'));
    assert.equal(kept.length, 1, 'the damaged file is set aside, not deleted');
    assert.equal(fs.readFileSync(path.join(rig.confDir, kept[0]), 'utf8'), '{"entries": [torn');
    assert.match(rig.serverOutput(), /codex queue wake: state file .* is damaged/);
    await rig.send(sender, target, 'second');
    await waitFor('the doubt is shown', 15000, () => rig.flagged(target));
    await pause(3000);
    assert.equal(rig.forTarget(target).length, 1, 'nothing is run for a session whose attempts are unknown');
    assert.equal(await rig.lookAtInbox(target), 2);
    await pause(1500);
    assert.equal(await rig.flagged(target), true, 'a look at the inbox does not lift the doubt');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).doubt.map((item: unknown[]) => item[0]).sort(), ['sender', 'target']);
    const fresh = await rig.launch('fresh');
    await rig.learnCreated(sender, fresh);
    await rig.send(sender, fresh, 'hello');
    await waitFor('a session started after the repair is woken', 15000, () => rig.forTarget(fresh).length === 1);
    assert.equal(await rig.flagged(fresh), false);
  });
});

describe('server: the conversation is checked again just before the exec, and must be in the foreground', () => {
  test('a session that switched conversation after the snapshot is not woken on the old one', async () => {
    const rig = new Rig();
    rigs.push(rig);
    await rig.start('cqw-verify-', {env: {MESH_CODEX_QUEUE_TIMEOUT_SECONDS: '10'}});
    const sender = await rig.launch('sender');
    const [first, second] = [await rig.launch('first'), await rig.launch('second')];
    for (const agent of [first, second]) await rig.learnCreated(sender, agent);
    const oldUuid = second.uuid;
    rig.mode('slow');                                     // the call for `first` takes 3 s: the round holds its snapshot
    await rig.send(sender, first, 'one');
    await waitFor('the slow call', 15000, () => rig.forTarget(first).length === 1);
    await rig.rotate(second);                             // `second` moves to a new conversation meanwhile
    await rig.send(sender, second, 'two');
    await pause(6000);
    assert.equal(rig.calls().filter(call => call.argv.includes(oldUuid)).length, 0,
      'no codex queue for the conversation `second` has left');
    await waitFor('the wake of the new conversation', 20000, () => rig.forTarget(second).length === 1);
    assert.notEqual(second.uuid, oldUuid);
  });

  test('a Codex in the background of its terminal is not woken', async () => {
    const rig = new Rig();
    rigs.push(rig);
    await rig.start('cqw-background-');
    const sender = await rig.launch('sender');
    const background = await rig.launch('background', false, ['background']);
    await rig.learnCreated(sender, background);
    await rig.send(sender, background, 'to a background codex');
    await pause(4000);
    assert.equal(rig.calls().length, 0, 'input does not go to a Codex that is not in the foreground');
    assert.equal(await rig.lookAtInbox(background), 1);
  });
});

describe('server: the Codex wake is off unless MESH_CODEX_QUEUE_WAKE=1', () => {
  test('an exact conversation is not woken by default: nothing run, nothing typed, the message waits', async () => {
    const rig = new Rig();
    rigs.push(rig);
    await rig.start('cqw-off-', {wake: false});
    const {sender, target} = await pair(rig, ['sender', 'target']);
    await rig.send(sender, target, 'hello');
    await pause(4000);
    assert.equal(rig.calls().length, 0, 'no codex queue');
    assert.equal(rig.typed(target), 0);
    assert.equal(await rig.flagged(target), false);
    assert.equal(await rig.lookAtInbox(target), 1);
    assert.equal(fs.existsSync(path.join(rig.confDir, 'codex-queue-wakes.json')), false, 'no state is even created');
  });

  for (const value of ['true', '0', '', 'yes']) {
    test(`MESH_CODEX_QUEUE_WAKE=${JSON.stringify(value)} leaves it off: nothing run, no state file`, async () => {
      const rig = new Rig();
      rigs.push(rig);
      await rig.start('cqw-off2-', {wake: false, env: {MESH_CODEX_QUEUE_WAKE: value}});
      const {sender, target} = await pair(rig, ['sender', 'target']);
      await rig.send(sender, target, 'hello');
      await pause(3000);
      assert.equal(rig.calls().length, 0);
      assert.equal(rig.typed(target), 0);
      assert.equal(await rig.flagged(target), false);
      assert.equal(await rig.lookAtInbox(target), 1);
      assert.deepEqual(fs.readdirSync(rig.confDir).filter(name => name.startsWith('codex-queue-wakes')), [],
        'no state file, no set-aside file');
    });
  }

  test('off, the state file of an earlier enabled trial is left alone (no repair, no mark)', async () => {
    const rig = new Rig();
    rigs.push(rig);
    const torn = '{"entries": [torn';
    await rig.start('cqw-off3-', {wake: false, prepare: where => {
      fs.mkdirSync(where.confDir, {recursive: true});
      fs.writeFileSync(path.join(where.confDir, 'codex-queue-wakes.json'), torn);
    }});
    const {sender, target} = await pair(rig, ['sender', 'target']);
    await rig.send(sender, target, 'hello');
    await pause(3000);
    assert.equal(rig.calls().length, 0);
    assert.equal(await rig.flagged(target), false);
    assert.equal(await rig.lookAtInbox(target), 1);
    assert.deepEqual(fs.readdirSync(rig.confDir).filter(name => name.startsWith('codex-queue-wakes')), ['codex-queue-wakes.json']);
    assert.equal(fs.readFileSync(path.join(rig.confDir, 'codex-queue-wakes.json'), 'utf8'), torn);
    assert.doesNotMatch(rig.serverOutput(), /codex queue wake: state file/);
  });
});
