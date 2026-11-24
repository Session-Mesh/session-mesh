// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// GET /api/agent-mail/messages: the owner's view of one live agent session's mailbox, texts
// included. It is for the owner's browser cookie alone, it is bounded, and it changes nothing:
// reading it neither grants the agent a read, nor consumes a "read once" grant, nor acknowledges
// a message. Run on a throwaway server, PTY host and fake Claude agents: HOME, configuration,
// runtime directory and port are the test's own.
import assert from 'node:assert/strict';
import {after, before, describe, test} from 'node:test';
import {AgentMesh, type Agent, type Identity} from './helpers/agent-mail-mesh.ts';

type Message = {id: string; source: Identity; target: Identity; kind: string; text: string; seq: number};
type Mailbox = {identity: Identity; received: Message[]; sent: Message[]; truncated: boolean;
  requests: {id: string; message_id: string}[]; always: {id: string; source: Identity; target: Identity}[]};

let lab: AgentMesh;
let mesh: AgentMesh['mesh'];
let agents: Record<string, Agent>;
let cookie = '';

before(async () => {
  lab = await AgentMesh.start('mbx-', ['alpha', 'beta', 'gamma', 'delta']);
  ({mesh, agents, cookie} = lab);
});
after(async () => { await lab?.stop(); });

const route = (session: string, created: number) => `${mesh.base}/api/agent-mail/messages?session=${session}&created=${created}`;
const send = (from: Agent, to: Agent, text: string, kind = 'message') => lab.send(from, to, text, kind);
const inbox = (agent: Agent) => lab.inbox(agent);
const readAs = (agent: Agent, id: string) => lab.readAs(agent, id);
const decide = (id: string, decision: string) => lab.decide(id, decision);
const ownerJson = () => lab.ownerJson();

async function mailbox(agent: Agent): Promise<Mailbox> {
  const response = await fetch(route(agent.name, agent.created), {headers: {Cookie: cookie}});
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json() as Promise<Mailbox>;
}

describe('GET /api/agent-mail/messages', () => {
  test('only the owner cookie reaches it: no cookie, master token, session token, or a header beside the cookie', async () => {
    const {alpha} = agents;
    const url = route('alpha', alpha!.created);
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, {headers: {Authorization: `Bearer ${mesh.token()}`}})).status, 401);
    assert.equal((await fetch(url, {headers: {Authorization: `MeshSession ${alpha!.token}`}})).status, 401);
    assert.equal((await fetch(url, {headers: {Authorization: `MeshSession ${agents.beta!.token}`}})).status, 401);
    assert.equal((await fetch(url, {headers: {Cookie: cookie, Authorization: `MeshSession ${alpha!.token}`}})).status, 401);
    assert.equal((await fetch(url, {headers: {Cookie: cookie, Authorization: `Bearer ${mesh.token()}`}})).status, 401);
    assert.equal((await fetch(url, {headers: {Cookie: cookie}})).status, 200);
  });

  test('the parameters are exactly a session name and a finite creation date of a live agent', async () => {
    const {alpha} = agents;
    const base = `${mesh.base}/api/agent-mail/messages`;
    const status = async (query: string) => (await fetch(`${base}${query}`, {headers: {Cookie: cookie}})).status;
    for (const query of ['', '?session=alpha', `?created=${alpha!.created}`, `?session=alpha&created=${alpha!.created}&x=1`,
      `?session=alpha&session=beta&created=${alpha!.created}`, `?session=a%2Fb&created=${alpha!.created}`,
      `?session=${'a'.repeat(49)}&created=${alpha!.created}`, '?session=alpha&created=nan', '?session=alpha&created=inf',
      '?session=alpha&created=abc', '?session=alpha&created=']) {
      assert.equal(await status(query), 400, query);
    }
    assert.equal(await status(`?session=nobody&created=${alpha!.created}`), 404);
    assert.equal(await status(`?session=alpha&created=${alpha!.created + 1}`), 404, 'another incarnation');
  });

  test('it returns the exact received and sent messages of one session, newest data included', async () => {
    const {alpha, beta, gamma} = agents;
    await send(alpha!, beta!, 'hello <b>beta</b>\nsecond line https://example.invalid/x');
    await send(alpha!, beta!, 'do the task', 'task');
    await send(beta!, alpha!, 'answer from beta');
    await send(gamma!, beta!, 'from gamma');

    const forBeta = await mailbox(beta!);
    assert.deepEqual(forBeta.identity, {id: 'beta', created: beta!.created, agent: 'claude'});
    assert.deepEqual(forBeta.received.map(({source, kind, text}) => [source.id, kind, text]), [
      ['alpha', 'message', 'hello <b>beta</b>\nsecond line https://example.invalid/x'],
      ['alpha', 'task', 'do the task'],
      ['gamma', 'message', 'from gamma']]);
    assert.ok(forBeta.received.every(message => message.target.id === 'beta' && message.target.created === beta!.created));
    assert.deepEqual(forBeta.sent.map(({target, text}) => [target.id, text]), [['alpha', 'answer from beta']]);
    assert.deepEqual(forBeta.requests.map(request => request.message_id).sort(),
      [...forBeta.received, ...forBeta.sent].map(message => message.id).sort());
    assert.deepEqual([forBeta.always, forBeta.truncated], [[], false]);

    const forAlpha = await mailbox(alpha!);
    assert.deepEqual(forAlpha.received.map(({source, text}) => [source.id, text]), [['beta', 'answer from beta']]);
    assert.deepEqual(forAlpha.sent.map(({target, text}) => [target.id, text]), [
      ['beta', 'hello <b>beta</b>\nsecond line https://example.invalid/x'], ['beta', 'do the task']]);
    const forDelta = await mailbox(agents.delta!);
    assert.deepEqual([forDelta.received, forDelta.sent], [[], []]);
  });

  test('reading it grants nothing, consumes no approval and acknowledges nothing', async () => {
    const {alpha, beta} = agents;
    const before = await inbox(beta!);
    assert.equal(before.length, 3);
    const first = (await mailbox(beta!)).received[0]!.id;

    // The deposit created the request. Reading it in the mailbox does not change the request.
    const requests = (await mailbox(beta!)).requests;
    const pending = requests.find(request => request.message_id === first)!;
    assert.ok(pending);
    for (let index = 0; index < 3; index += 1) await mailbox(beta!);
    assert.equal((await readAs(beta!, first)).status, 202, 'owner reading is not a grant');
    assert.deepEqual((await mailbox(beta!)).requests, requests);
    assert.ok((await mailbox(alpha!)).requests.some(request => request.id === pending.id), 'the sender is concerned too');
    assert.deepEqual((await mailbox(agents.delta!)).requests, [], 'an unrelated session is not');

    // Yes once, then the owner reads repeatedly: the single-use grant is still there.
    assert.equal((await decide(pending.id, 'yes')).status, 200);
    assert.deepEqual((await mailbox(beta!)).requests, requests.filter(request => request.id !== pending.id));
    for (let index = 0; index < 3; index += 1) await mailbox(beta!);
    const revealed = await readAs(beta!, first);
    assert.equal(revealed.status, 200, 'the once-grant survived the owner reading');
    assert.equal(((await revealed.json()) as {message: {text: string}}).message.text,
      'hello <b>beta</b>\nsecond line https://example.invalid/x');
    assert.equal((await readAs(beta!, first)).status, 202, 'and was consumed by the agent\'s own read only');
    assert.deepEqual(await inbox(beta!), before, 'nothing was acknowledged or dropped');
    assert.equal((await mailbox(beta!)).received.length, 3);
  });

  test('an always policy shows for both sessions and revocation removes it', async () => {
    const {alpha, beta} = agents;
    const second = (await mailbox(beta!)).received[1]!.id;
    assert.equal((await readAs(beta!, second)).status, 202);
    const request = (await mailbox(beta!)).requests.find(item => item.message_id === second)!;
    assert.equal((await decide(request.id, 'always')).status, 200);
    for (const agent of [alpha!, beta!]) {
      const view = await mailbox(agent);
      assert.equal(view.always.length, 1);
      assert.deepEqual([view.always[0]!.source.id, view.always[0]!.target.id], ['alpha', 'beta']);
    }
    assert.deepEqual((await mailbox(agents.gamma!)).always, []);
    const policy = (await mailbox(beta!)).always[0]!.id;
    const revoke = await fetch(`${mesh.base}/api/agent-mail/consent/revoke`,
      {method: 'POST', headers: ownerJson(), body: JSON.stringify({policy_id: policy})});
    assert.equal(revoke.status, 200);
    assert.deepEqual((await mailbox(beta!)).always, []);
  });

  test('the answer is bounded: the sent list keeps the most recent 64 and says it was cut', async () => {
    const {alpha, gamma, delta} = agents;
    // alpha already sent 2 to beta: 32 to gamma and 31 more to delta make 65.
    for (let index = 0; index < 32; index += 1) await send(alpha!, gamma!, `to gamma ${index}`);
    for (let index = 0; index < 31; index += 1) await send(alpha!, delta!, `to delta ${index}`);
    const view = await mailbox(alpha!);
    assert.equal(view.sent.length, 64);
    assert.equal(view.truncated, true);
    assert.equal(view.sent.at(-1)!.text, 'to delta 30');
    assert.ok(view.sent.every((message, index, all) => index === 0 || all[index - 1]!.seq < message.seq));
    assert.ok(JSON.stringify(view).length < 64 * 8192 * 2);
  });
});
