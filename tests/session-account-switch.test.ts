// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Account switch requests (docs/agent-guide.md "Ask for sessions"): a Claude or Codex session asks, with its
// session token, to continue its conversation under another account alias. The server resolves the name for the
// session's own agent kind (never one the body names), refuses with a code and a message what cannot be carried
// out, and does nothing until the owner approves. Once approved: the exact source stops, `mesh-platform accounts
// carry` copies the conversation, and the agent resumes under the target; when the carry fails the conversation
// resumes under its own account (rolled_back). A fake `codex` on PATH records its Codex home and arguments, and
// writes and holds open a rollout as the real one does, so the listing knows its conversation.
// `mesh-platform` comes from MESH_MESH_PLATFORM_CMD or the dune build (MESH_REQUIRE_MESH_PLATFORM=1: required); the
// cases that carry a conversation need its `accounts carry` command and are skipped, with the reason, without it.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import {installFakeCodex, launchesIn, rolloutIn} from './fake-codex-lib.ts';
import {REPO, type Mesh, startMesh} from './mesh-server-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';
import {createSessionRequestGate, setTranslator} from '../static/pane-actions.ts';

const PLATFORM = process.env.MESH_MESH_PLATFORM_CMD
  || path.join(REPO, 'ocaml', '_build', 'default', 'platform', 'cli', 'mesh_platform_main.exe');
const SKIP = fs.existsSync(PLATFORM) || process.env.MESH_REQUIRE_MESH_PLATFORM ? false
  : `mesh-platform not built: dune build ./platform/cli/mesh_platform_main.exe, or set MESH_MESH_PLATFORM_CMD (${PLATFORM})`;
// `accounts carry` is in the usage text of a mesh-platform that has it.
const CARRY = SKIP ? SKIP : spawnSync(PLATFORM, [], {encoding: 'utf8'}).stderr?.includes('accounts carry') ? false
  : `this mesh-platform has no accounts carry command (${PLATFORM})`;

let mesh: Mesh;
let bin: string;
let log: string;
let cookie = '';
let host: ChildProcess | undefined;
let travelHome: string, workHome: string, clientClaude: string;

before(async () => {
  if (SKIP) return;
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-bin-'));
  const installed = installFakeCodex(bin);
  log = installed.log;
  const PATH = installed.PATH;
  mesh = await startMesh('switch-', {PATH, MESH_MESH_PLATFORM_CMD: PLATFORM, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined});
  const accounts = path.join(mesh.home, '.agent-accounts');
  fs.mkdirSync(accounts, {mode: 0o700});
  travelHome = path.join(accounts, 'travel', '.codex');   // missing: created when a request names it
  workHome = path.join(accounts, 'work', '.codex');
  clientClaude = path.join(accounts, 'client', '.claude');
  for (const folder of ['travel', 'work', 'client', 'twin', 'spare', 'mirror']) fs.mkdirSync(path.join(accounts, folder), {mode: 0o700});
  fs.mkdirSync(workHome, {mode: 0o700});
  fs.mkdirSync(clientClaude, {mode: 0o700});
  fs.writeFileSync(path.join(mesh.confDir, 'accounts.json'), JSON.stringify({v: 1, accounts: [
    {id: 'travel', label: 'Travel', codex_home: travelHome},
    {id: 'work', label: 'Work', codex_home: workHome},
    {id: 'client', label: 'Client', claude_config_dir: clientClaude},
    // labels are unique among the aliases, but one can equal the default account's
    {id: 'twin', label: 'Default Account', codex_home: path.join(accounts, 'twin', '.codex')},
    // one account's label is another's id: that name designates neither (Mesh_account_resolver)
    {id: 'spare', label: 'Reserve', codex_home: path.join(accounts, 'spare', '.codex')},
    {id: 'mirror', label: 'spare', codex_home: path.join(accounts, 'mirror', '.codex')},
  ]}), {mode: 0o600});
  const [command, ...args] = ptyhostArgv();
  host = spawn(command!, args, {cwd: REPO, stdio: 'ignore',
    env: {PATH, HOME: mesh.home, XDG_RUNTIME_DIR: path.join(mesh.home, 'run'), LANG: 'C', SHELL: '/bin/sh'}});
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(mesh.home, 'run', 'session-mesh', 'ptyhost.sock')); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const login = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: mesh.token()})});
  cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie);
});

after(async () => {
  // The fake agents outlive the PTY host; a process named codex left running would be seen by the next suites'
  // listings (they would read its rollout and write a cache).
  if (bin) spawnSync('pkill', ['-KILL', '-f', path.join(bin, 'real', 'codex')]);
  host?.kill('SIGKILL');
  await mesh?.stop();
  if (bin) fs.rmSync(bin, {recursive: true, force: true});
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const launches = () => launchesIn(log);
const owner = () => ({Cookie: cookie, Origin: mesh.base, 'Content-Type': 'application/json'});

type Session = {name: string; token: string; sid: string};

/** A Codex session started under ``account`` (absent: the default one), once the listing knows its conversation. */
async function codexSession(name: string, account?: string, cwd?: string): Promise<Session> {
  const response = await fetch(`${mesh.base}/api/new`, {method: 'POST', body: JSON.stringify({cwd: cwd ?? mesh.home,
    preset: 'codex', name, ...account ? {account} : {}}),
  headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'}});
  assert.equal(response.status, 200, await response.clone().text());
  let token = '', sid = '';
  for (let attempt = 0; attempt < 150 && !(token && sid); attempt += 1) {
    token = launches().find(fields => fields[2] === name)?.[4] ?? '';
    sid = ((await listed(name))?.agent as {session_id?: string} | null)?.session_id ?? '';
    if (!(token && sid)) await sleep(200);
  }
  assert.ok(token && sid, `the fake codex of ${name} is listed with its conversation`);
  return {name, token, sid};
}

async function listed(name: string): Promise<Record<string, unknown> | undefined> {
  const data = await (await fetch(`${mesh.base}/api/sessions`, {headers: {Authorization: `Bearer ${mesh.token()}`}}))
    .json() as {mesh: Record<string, unknown>[]};
  return data.mesh.find(item => item.id === name);
}

/** Rename session ``name`` LABEL as the list does, and file it in a folder (which ranks it). */
async function arrange(name: string): Promise<void> {
  const headers = {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'};
  for (const op of [{op: 'folder-add', name: 'Moved'}, {op: 'move', id: name, folder: 'Moved'}, {op: 'rename', id: name, label: LABEL}]) {
    const done = await fetch(`${mesh.base}/api/organize`, {method: 'POST', headers, body: JSON.stringify(op)});
    assert.equal(done.status, 200, await done.text());
  }
}

/** The label and folder of session ``name``, read twice: the second listing would prune those of an ended incarnation. */
async function arrangement(name: string): Promise<unknown[]> {
  await listed(name);
  const item = await listed(name);
  return [item?.label, item?.folder];
}

const LABEL = 'Renamed before the switch';

const ask = (session: Session, body: Record<string, unknown>) => fetch(`${mesh.base}/api/session-actions/@self/request`,
  {method: 'POST', body: JSON.stringify(body),
    headers: {Authorization: `MeshSession ${session.token}`, 'Content-Type': 'application/json'}});

type Request = {id: string; state: string; account: string | null; from_account: string | null;
  result: {id?: string; account?: string; error?: string; rolled_back?: boolean; code?: string;
    retryable?: boolean; operator_action?: boolean} | null};

async function requested(session: Session, account: unknown): Promise<Request> {
  const response = await ask(session, {action: 'switch_account', account});
  assert.equal(response.status, 202, await response.clone().text());
  return (await response.json() as {request: Request}).request;
}

/** The coded refusal of a switch request: [code, message]. */
async function refused(session: Session, account: unknown): Promise<[string, string]> {
  const response = await ask(session, {action: 'switch_account', account});
  const text = await response.text();
  assert.equal(response.status, 400, text);
  const {error} = JSON.parse(text) as {error: {code: string; message: string}};
  return [error.code, error.message];
}

async function decide(request: Request, approve: boolean): Promise<Request> {
  const claimed = await fetch(`${mesh.base}/api/session-actions/${request.id}/claim`, {method: 'POST', headers: owner(),
    body: JSON.stringify({tab_nonce: 'b'.repeat(32)})});
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const {claim_nonce: claimNonce} = await claimed.json() as {claim_nonce: string};
  const decided = await fetch(`${mesh.base}/api/session-actions/${request.id}/decision`, {method: 'POST', headers: owner(),
    body: JSON.stringify({approve, claim_nonce: claimNonce})});
  assert.equal(decided.status, 200, await decided.clone().text());
  return (await decided.json() as {request: Request}).request;
}

/** The last resume the fake codex recorded in session ``name`` (a name freed by the stop can be reused): [CODEX_HOME, arguments]. */
async function launchOf(name: string): Promise<[string, string]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = launches().findLast(fields => fields[2] === name && fields[3]!.startsWith('resume'));
    if (found) return [found[1]!, found[3]!];
    await sleep(100);
  }
  throw new Error(`no codex launched in ${name}`);
}

describe('account switch requests', {skip: SKIP}, () => {
  let source: Session;

  test('a name is an exact id or one label ignoring case, for the agent of the session; anything else is refused with the list', async () => {
    source = await codexSession('x-ask');
    const [unknown, listing] = await refused(source, 'trav');
    assert.equal(unknown, 'account_unknown', 'no prefix match');
    assert.match(listing, /^No Codex account “trav” is declared\. Available: default \(Default account\), travel \(Travel\), work \(Work\), twin/);
    assert.doesNotMatch(listing, /client/, 'only the accounts of the session\'s agent are offered');
    assert.ok(!listing.includes('.agent-accounts') && !listing.includes(mesh.home), 'no folder in a refusal');
    const [ambiguous, candidates] = await refused(source, 'default ACCOUNT');
    assert.equal(ambiguous, 'account_ambiguous', 'two labels equal without case: none is chosen');
    assert.match(candidates, /matches several accounts: default \(Default account\), twin \(Default Account\)\./);
    const [noAgent, noAgentText] = await refused(source, 'client');
    assert.equal(noAgent, 'account_no_agent');
    assert.match(noAgentText, /^Account Client has no Codex folder; it serves: Claude\.$/);
    assert.equal((await refused(source, 'Client'))[0], 'account_unknown', 'a label names an account of this agent only');
    assert.equal((await refused(source, 'default'))[0], 'account_same');
    assert.equal((await refused(source, 'work '))[0], 'account_unknown', 'no trimming');
    for (const bad of ['', 'x'.repeat(65), 42, null, ['travel'], {id: 'travel'}]) {
      assert.equal((await refused(source, bad))[0], 'account_unknown', JSON.stringify(bad));
    }
    const byLabel = await requested(source, 'TRAVEL');
    assert.deepEqual([byLabel.account, byLabel.from_account, byLabel.state], ['travel', 'default', 'pending']);
    assert.equal(fs.statSync(travelHome).mode & 0o777, 0o700, "the target's folder is prepared, private");
  });

  test("an id that is also another account's label designates neither: refused, both listed", async () => {
    const [code, message] = await refused(source, 'spare');
    assert.equal(code, 'account_ambiguous');
    assert.match(message, /^“spare” matches several accounts: spare \(Reserve\), mirror \(spare\)\./);
    assert.ok(!message.includes('.agent-accounts') && !message.includes(mesh.home), 'no folder');
    // an id is matched with its case, a label ignoring it: SPARE is only mirror's label
    assert.equal((await requested(source, 'SPARE')).account, 'mirror');
    assert.equal((await requested(source, 'Reserve')).account, 'spare', 'its label alone still names it');
  });

  test('the agent kind is the session\'s: a body naming another agent or session is refused, and no other action names an account', async () => {
    const before = launches().length;
    // refused for their shape, before any account is looked at (Client serves Claude only: never this Codex session)
    for (const body of [{action: 'switch_account', account: 'client', agent: 'claude'},
      {action: 'switch_account', account: 'client', preset: 'claude'},
      {action: 'switch_account', account: 'travel', session: 'other'},
      {action: 'switch_account', account: 'travel', model: 'gpt-5'}]) {
      const response = await ask(source, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(await response.text(), 'Invalid request fields', JSON.stringify(body));
    }
    for (const body of [{action: 'restart', account: 'travel'}, {action: 'create', preset: 'codex', account: 'travel'}]) {
      const response = await ask(source, body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(await response.text(), 'Only an account switch names an account', JSON.stringify(body));
    }
    await sleep(300);
    assert.equal(launches().length, before, 'nothing started');
  });

  test('a conversation the listing only guesses from the folder is never carried to another account', async () => {
    const folder = path.join(mesh.home, 'guess');
    fs.mkdirSync(folder, {mode: 0o700});
    const session = await codexSession('x-guess', undefined, folder);
    assert.equal(((await listed('x-guess'))?.agent as {identity_source?: string}).identity_source, 'cwd_unique');
    const [code] = await refused(session, 'travel');
    assert.equal(code, 'conversation_unknown', 'a guess (cwd_unique) is not the exact conversation');
    const auth = {Authorization: `MeshSession ${session.token}`};
    const status = await fetch(`${mesh.base}/api/session-actions/@self/request?view=control`, {headers: auth});
    assert.equal(status.status, 200);
    assert.equal((await status.json() as {control: {transition: string}}).control.transition, 'unavailable');
    const before = launches().length;
    const settings = await ask(session, {action: 'settings', effort: 'low'});
    assert.equal(settings.status, 409);
    assert.equal(launches().length, before, 'a guessed conversation cannot be restarted with settings');
  });

  test("a conversation not found in its account's folder is refused, also when that folder is missing", async () => {
    const twin = path.join(mesh.home, '.agent-accounts', 'twin');
    const session = await codexSession('x-nofolder', 'twin');
    const queued = await requested(session, 'travel');
    const before = launches().length;
    // the agent keeps its rollout open (still listed with its conversation), but twin's Codex home is gone
    fs.renameSync(path.join(twin, '.codex'), path.join(twin, 'moved'));
    try {
      const [code] = await refused(session, 'travel');
      assert.equal(code, 'conversation_not_found', 'nothing to carry: never queued');
      const decided = await decide(queued, true);
      assert.equal(decided.state, 'failed', JSON.stringify(decided));
      assert.equal(decided.result?.error, "The conversation is not in the current account's folder");
      assert.ok(!decided.result?.rolled_back, 'checked before the stop');
      await sleep(500);
      assert.equal(launches().length, before, 'nothing stopped or launched');
      assert.ok(await listed('x-nofolder'), 'the source still runs');
    } finally {
      fs.renameSync(path.join(twin, 'moved'), path.join(twin, '.codex'));
    }
  });

  test('nothing is stopped or launched without the owner: a pending request waits, a declined one ends', async () => {
    const before = launches().length;
    const request = await requested(source, 'work');
    await sleep(1500);
    assert.equal(launches().length, before, 'no agent started while the request waits');
    assert.ok(await listed('x-ask'), 'the source still runs');
    const status = await fetch(`${mesh.base}/api/session-actions/@self/request?id=${request.id}`,
      {headers: {Authorization: `MeshSession ${source.token}`}});
    assert.equal((await status.json() as {request: Request}).request.state, 'pending');
    const declined = await decide(request, false);
    assert.equal(declined.state, 'rejected');
    await sleep(500);
    assert.equal(launches().length, before, 'a declined request starts nothing');
    assert.ok(await listed('x-ask'), 'and stops nothing');
  });

  test('a target refused once approved stops nothing and never falls back to the default account', async () => {
    const session = await codexSession('x-refused', 'work');
    const request = await requested(session, 'travel');
    const before = launches().length;
    const file = path.join(mesh.confDir, 'accounts.json');
    const declared = fs.readFileSync(file, 'utf8');
    const {accounts} = JSON.parse(declared) as {accounts: {id: string}[]};
    // the operator removes the target alias after the request: it is unknown at execution
    fs.writeFileSync(file, JSON.stringify({v: 1, accounts: accounts.filter(account => account.id !== 'travel')}), {mode: 0o600});
    try {
      const decided = await decide(request, true);
      assert.equal(decided.state, 'failed', JSON.stringify(decided));
      assert.match(decided.result!.error!, /^Unknown account alias/);
      assert.ok(!decided.result?.rolled_back, 'nothing was stopped');
    } finally {
      fs.writeFileSync(file, declared, {mode: 0o600});
    }
    await sleep(500);
    assert.equal(launches().length, before, 'no agent started, under no account');
    assert.ok(await listed('x-refused'), 'the source still runs');
  });

  test('approved: the agent stops, its conversation is carried, and it resumes under the target in the same terminal', {skip: CARRY}, async () => {
    const session = await codexSession('x-move');
    await arrange('x-move');
    const before = await listed('x-move');
    const carried = rolloutIn(travelHome, session.sid);
    const original = fs.readFileSync(rolloutIn(path.join(mesh.home, '.codex'), session.sid), 'utf8');
    const decided = await decide(await requested(session, 'Travel'), true);
    assert.equal(decided.state, 'completed', JSON.stringify(decided));
    assert.equal(decided.result?.account, 'travel');
    assert.equal(decided.result?.id, 'x-move', 'the same session, under its own name');
    const [home, argv] = await launchOf('x-move');
    assert.equal(home, travelHome, "the resumed agent runs with the target's Codex home");
    assert.match(argv, new RegExp(`^resume ${session.sid}`));
    assert.equal(launches().findLast(fields => fields[2] === 'x-move')?.[5], 'no', 'the old agent was gone before the resume');
    // the carried copy first, then what the resumed agent wrote: the conversation was there before it started
    assert.ok(fs.readFileSync(carried, 'utf8').startsWith(original), 'the conversation was carried before the resume');
    const after = await listed('x-move');
    assert.ok(after, 'the session is still listed');
    assert.equal(after?.account, 'travel');
    // a new session would have a new nonce, so a new token in its shell's environment
    assert.equal(launches().findLast(fields => fields[2] === 'x-move')?.[4], session.token,
      'the same shell and terminal: no new session was created');
    assert.equal(typeof before?.created, 'number');
    assert.notEqual(after?.created, before?.created, 'a new incarnation of the session');
    assert.deepEqual(await arrangement('x-move'), [LABEL, 'Moved'], 'the new incarnation keeps the name and folder');
  });

  test('a carry that fails resumes the conversation under its own account and says it was undone', {skip: CARRY}, async () => {
    const session = await codexSession('x-undone');
    await arrange('x-undone');
    const before = await listed('x-undone');
    const target = rolloutIn(workHome, session.sid);
    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
    fs.writeFileSync(target, '{"type":"session_meta","payload":{"other":"copy"}}\n', {mode: 0o600});   // a divergent copy
    const decided = await decide(await requested(session, 'work'), true);
    assert.equal(decided.state, 'failed', JSON.stringify(decided));
    assert.equal(decided.result?.rolled_back, true);
    assert.equal(decided.result?.code, 'conversation_diverged');
    assert.match(decided.result!.error!, /^Switch undone: the conversation resumed under account default\. Cause: conversation_diverged/);
    assert.match(decided.result!.error!, /Asking again does not change this\.$/, 'a refusal, not a retryable failure');
    assert.deepEqual([decided.result?.retryable, decided.result?.operator_action], [false, false]);
    assert.equal(decided.result?.id, 'x-undone', 'resumed in the same session');
    const [home, argv] = await launchOf('x-undone');
    assert.equal(home, 'unset', "resumed under its own (default) account, never the target's");
    assert.match(argv, new RegExp(`^resume ${session.sid}`));
    assert.equal(launches().findLast(fields => fields[2] === 'x-undone')?.[5], 'no', 'the old agent was gone before the resume');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"type":"session_meta","payload":{"other":"copy"}}\n', 'the target copy is untouched');
    const after = await listed('x-undone');
    assert.ok(after, 'the session is still listed');
    assert.equal(after?.account, undefined, 'the resumed session runs under the default account');
    assert.equal(launches().findLast(fields => fields[2] === 'x-undone')?.[4], session.token,
      'in the same shell and terminal');
    assert.equal(typeof before?.created, 'number');
    assert.notEqual(after?.created, before?.created, 'a new incarnation of the session');
    assert.deepEqual(await arrangement('x-undone'), [LABEL, 'Moved'], 'the resumed incarnation keeps the name and folder');
  });
});

describe("the owner's switch dialog", () => {
  const dialog = async (language: string, request: Record<string, unknown>): Promise<string[]> => {
    const catalog = JSON.parse(fs.readFileSync(path.join(REPO, 'static', 'i18n', `${language}.json`), 'utf8')) as Record<string, string>;
    setTranslator((key, params = {}) => (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name])));
    const shown: string[] = [];
    const gate = createSessionRequestGate({
      claim: async () => ({kind: 'claimed', claimNonce: 'n'.repeat(32)}),
      confirm: message => { shown.push(message); return false; },
      decide: async () => 'settled',
      notify: () => {},
    });
    await gate.consider([{id: 'r', action: 'switch_account', state: 'pending', preset: 'codex', model: null,
      source: {id: 'x-agent'}, ...request}]);
    return shown;
  };
  const request = {account: 'travel', account_label: 'Travel', from_account: 'default', from_label: 'Default account'};

  test('says which accounts, and that the whole conversation goes to the other account', async () => {
    const [english] = await dialog('en', request);
    assert.match(english!, /^Agent “x-agent” asks to move from account Default account \(default\) to account Travel \(travel\)\./);
    assert.match(english!, /whole conversation will be copied .* and sent to that account’s provider/);
    const [french] = await dialog('fr', request);
    assert.match(french!, /^L’agent « x-agent » demande à passer du compte Default account \(default\) au compte Travel \(travel\)\./);
    assert.match(french!, /Toute sa conversation sera copiée .* et envoyée au fournisseur de ce compte/);
    assert.doesNotMatch(french!, /propriétaire/);
  });

  test('describes every selected setting before approval in English and French', async () => {
    const settings = {action: 'settings', model: 'test-model', effort: 'high'};
    for (const language of ['en', 'fr']) {
      const [text] = await dialog(language, settings);
      assert.match(text!, /test-model/);
      assert.match(text!, /high/);
      const [effortOnly] = await dialog(language, {...settings, model: null});
      assert.match(effortOnly!, /high/);
      assert.match(effortOnly!, /configuration/);
      assert.deepEqual(await dialog(language, {...settings, model: null, effort: null}), []);
    }
  });

  test('a switch request without both accounts is never shown', async () => {
    assert.deepEqual(await dialog('en', {account: 'travel'}), []);
    assert.deepEqual(await dialog('en', {from_account: 'default'}), []);
  });
});
