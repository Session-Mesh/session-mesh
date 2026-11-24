// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, test} from 'node:test';
import {rolloutIn} from './fake-codex-lib.ts';
import {REPO} from './mesh-server-lib.ts';
import {createSessionRequestGate, setTranslator} from '../static/pane-actions.ts';
import {SKIP, PROFILE_SKIP, CARRY, mesh, log, travelHome, workHome, sleep, launches, owner,
  codexSession, listed, arrange, arrangement, LABEL, installNativeProfiles, nativeProfiles,
  consentPolicy, unchangedSource, ask, requested, refused, decide, launchOf,
  type Session, type Request} from './session-account-switch-fixture.ts';

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

  test('native profiles refuse before queueing, across profile and default directions despite skip consent',
    {skip: process.platform === 'linux' ? 'native switches are qualified on Linux' : PROFILE_SKIP}, async () => {
    const registry = installNativeProfiles();
    try {
      await nativeProfiles();
      const consent = await fetch(`${mesh.base}/api/accounts/consent/set-global`, {method: 'POST', headers: owner(),
        body: JSON.stringify({expected_revision: 0, confirmation: 'skip'})});
      assert.equal(consent.status, 200, await consent.clone().text());
      const policy = await consentPolicy() as {revision: number; global: string; pairs: unknown[]};
      assert.deepEqual([policy.revision, policy.global, policy.pairs], [1, 'skip', []]);

      for (const [name, from, to] of [
        ['x-profile-switch', 'work', 'travel'],
        ['x-default-to-profile', 'default', 'work'],
        ['x-profile-to-default', 'work', 'default'],
      ] as const) {
        const session = await codexSession(name, from === 'default' ? undefined : from);
        const before = (await listed(session.name))!;
        if (from !== 'default') assert.match(String(before?.account_context_revision), /^[a-f0-9]{64}$/);
        const original = rolloutIn(from === 'default' ? path.join(mesh.home, '.codex') : workHome, session.sid);
        const target = rolloutIn(to === 'default' ? path.join(mesh.home, '.codex') : to === 'work' ? workHome : travelHome,
          session.sid);
        const transcript = fs.readFileSync(original);
        assert.equal(fs.existsSync(target), false, `${name}: no target transcript before the request`);
        const launchLog = fs.readFileSync(log, 'utf8');

        assert.deepEqual(await refused(session, to),
          ['switch_not_qualified', 'Native profile switching is not qualified']);
        await unchangedSource(session, before, launchLog);
        assert.deepEqual(fs.readFileSync(original), transcript, `${name}: no source transcript write`);
        assert.equal(fs.existsSync(target), false, `${name}: no conversation copied to the target`);
      }
      assert.deepEqual(await consentPolicy(), policy, 'stored consent was not consumed or changed');
    } finally {
      fs.rmSync(registry);
    }
  });

  test('parallel native profiles isolate processes and an approved switch leaves the other sessions intact',
    {skip: PROFILE_SKIP || (process.platform !== 'linux' ? '/proc process environment required' : false)}, async () => {
    const registry = installNativeProfiles();
    try {
      await nativeProfiles();
      // Synthetic auth-file writes model disk isolation only, not a real OAuth refresh.
      const [work, travel, plain] = await Promise.all([
        codexSession('native-work', 'work'), codexSession('native-travel', 'travel'), codexSession('native-default'),
      ]);
      const pidOf = (name: string) => Number(fs.readFileSync(`${log}.${name}`, 'utf8').trim());
      const actualHome = (pid: number) => {
        const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
        const variable = env.find(item => item.startsWith('CODEX_HOME='));
        return variable ? variable.slice(11) : `${env.find(item => item.startsWith('HOME='))!.slice(5)}/.codex`;
      };
      const workPid = pidOf(work.name), travelPid = pidOf(travel.name), plainPid = pidOf(plain.name);
      assert.deepEqual([actualHome(workPid), actualHome(travelPid), actualHome(plainPid)],
        [workHome, travelHome, path.join(mesh.home, '.codex')]);
      const defaultAuth = path.join(mesh.home, '.codex', 'auth.json');
      fs.writeFileSync(defaultAuth, '{"fakeAccount":"default"}');
      fs.writeFileSync(path.join(workHome, 'auth.json'), '{"fakeAccount":"work-relogin"}');
      const before = (await listed(work.name))!;
      const switched = await decide(await requested(work, 'travel'), true);
      assert.equal(switched.state, 'completed', JSON.stringify(switched));
      await launchOf(work.name);
      const switchedPid = pidOf(work.name);
      assert.notEqual(switchedPid, workPid, 'the agent was relaunched');
      assert.equal(actualHome(switchedPid), travelHome);
      assert.equal((await listed(work.name))!.id, before.id);
      assert.equal(launches().findLast(fields => fields[2] === work.name)?.[4], work.token,
        'the relaunched agent keeps the session token');
      assert.deepEqual([pidOf(travel.name), pidOf(plain.name)], [travelPid, plainPid]);
      assert.deepEqual([actualHome(travelPid), actualHome(plainPid)], [travelHome, path.join(mesh.home, '.codex')]);
      assert.equal(fs.readFileSync(defaultAuth, 'utf8'), '{"fakeAccount":"default"}');
      const made = await ask(plain, {action: 'restart'});
      assert.equal(made.status, 202, await made.clone().text());
      const {request} = await made.json() as {request: Request};
      const restarted = await decide(request, true);
      assert.equal(restarted.state, 'completed', JSON.stringify(restarted));
      await launchOf(plain.name);
      assert.equal(actualHome(pidOf(plain.name)), path.join(mesh.home, '.codex'));
      assert.equal(launches().findLast(fields => fields[2] === plain.name)?.[4], plain.token);
      assert.equal(actualHome(switchedPid), travelHome);
      assert.equal(actualHome(travelPid), travelHome);
    } finally { fs.rmSync(registry); }
  });

  test('a legacy request queued before native registry activation is refused on approval without a stop or copy',
    {skip: PROFILE_SKIP}, async () => {
    const session = await codexSession('x-legacy-activated');
    const before = (await listed(session.name))!;
    const original = rolloutIn(path.join(mesh.home, '.codex'), session.sid);
    const target = rolloutIn(travelHome, session.sid);
    const transcript = fs.readFileSync(original);
    assert.equal(fs.existsSync(target), false);
    const policy = await consentPolicy();
    const request = await requested(session, 'travel');
    assert.deepEqual([request.state, request.from_account, request.account], ['pending', 'default', 'travel']);
    const launchLog = fs.readFileSync(log, 'utf8');
    const registry = installNativeProfiles();
    try {
      await nativeProfiles();
      const decided = await decide(request, true);
      assert.equal(decided.state, 'failed', JSON.stringify(decided));
      assert.equal(decided.result?.error, process.platform === 'linux'
        ? 'Native account switch request has no valid binding' : 'Native profile switching is not qualified');
      assert.ok(!decided.result?.rolled_back, 'the source was never stopped');
      await unchangedSource(session, before, launchLog);
      assert.deepEqual(fs.readFileSync(original), transcript, 'source conversation unchanged');
      assert.equal(fs.existsSync(target), false, 'no target transcript written');
      assert.deepEqual(await consentPolicy(), policy, 'consent remains stored and unchanged');
    } finally {
      fs.rmSync(registry);
    }
  });

  test('the native migration marker refuses before preparing a missing legacy target folder',
    {skip: process.platform === 'linux' ? 'native switches are qualified on Linux' : false}, async () => {
    const session = await codexSession('x-marker-refusal');
    const before = (await listed(session.name))!;
    const accountFile = path.join(mesh.confDir, 'accounts.json');
    const originalAccounts = fs.readFileSync(accountFile, 'utf8');
    const target = path.join(mesh.home, '.agent-accounts/fresh/.codex');
    fs.mkdirSync(path.dirname(target), {mode: 0o700});
    const declared = JSON.parse(originalAccounts) as {v: number; accounts: Record<string, unknown>[]};
    declared.accounts.push({id: 'fresh', label: 'Fresh', codex_home: target});
    fs.writeFileSync(accountFile, JSON.stringify(declared), {mode: 0o600});
    assert.equal(fs.existsSync(target), false);
    const launchLog = fs.readFileSync(log, 'utf8');
    const marker = path.join(mesh.confDir, 'backend-profiles.migrated');
    fs.writeFileSync(marker, '', {mode: 0o600});
    try {
      assert.deepEqual(await refused(session, 'fresh'),
        ['switch_not_qualified', 'Native profile switching is not qualified']);
      assert.equal(fs.existsSync(target), false, 'no legacy target folder prepared');
      await unchangedSource(session, before, launchLog);
    } finally {
      fs.rmSync(marker);
      fs.writeFileSync(accountFile, originalAccounts, {mode: 0o600});
    }
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

  test('parallel Codex accounts remain isolated through a switch, relogin and restart',
    {skip: CARRY || (process.platform !== 'linux' ? '/proc process environment required' : false)}, async () => {
    // Synthetic auth files only: never use the operator's accounts or credentials.
    const defaultHome = path.join(mesh.home, '.codex');
    for (const [folder, value] of [[defaultHome, 'default'], [workHome, 'work'], [travelHome, 'travel']]) {
      fs.mkdirSync(folder!, {recursive: true, mode: 0o700});
      fs.writeFileSync(path.join(folder!, 'auth.json'), JSON.stringify({fakeAccount: value}), {mode: 0o600});
    }
    const [plain, work, moving] = await Promise.all([
      codexSession('parallel-default'), codexSession('parallel-work', 'work'), codexSession('parallel-moving', 'travel'),
    ]);
    const pidOf = (name: string) => Number(fs.readFileSync(`${log}.${name}`, 'utf8').trim());
    const environment = (pid: number) => fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
    const actualHome = (pid: number) => {
      const env = environment(pid);
      const variable = env.find(item => item.startsWith('CODEX_HOME='));
      return variable ? variable.slice('CODEX_HOME='.length) : `${env.find(item => item.startsWith('HOME='))!.slice(5)}/.codex`;
    };
    const plainPid = pidOf(plain.name), workPid = pidOf(work.name), movingPid = pidOf(moving.name);
    assert.deepEqual([actualHome(plainPid), actualHome(workPid), actualHome(movingPid)], [defaultHome, workHome, travelHome]);
    const workAuth = fs.readFileSync(path.join(workHome, 'auth.json'), 'utf8');
    const defaultAuth = fs.readFileSync(path.join(defaultHome, 'auth.json'), 'utf8');

    const switched = await decide(await requested(moving, 'work'), true);
    assert.equal(switched.state, 'completed', JSON.stringify(switched));
    await launchOf(moving.name);
    assert.equal(actualHome(pidOf(moving.name)), workHome);
    assert.equal(launches().findLast(fields => fields[2] === moving.name)?.[4], moving.token, 'switch stays in the same PTY');
    assert.equal(pidOf(work.name), workPid, 'the other work session was not restarted');
    assert.equal(actualHome(workPid), workHome);
    assert.equal(actualHome(plainPid), defaultHome);
    assert.equal(fs.readFileSync(path.join(workHome, 'auth.json'), 'utf8'), workAuth);
    assert.equal(fs.readFileSync(path.join(defaultHome, 'auth.json'), 'utf8'), defaultAuth);

    // Simulate an auth-file update, not a real OAuth refresh, and verify the default file is unchanged.
    fs.writeFileSync(path.join(workHome, 'auth.json'), JSON.stringify({fakeAccount: 'work-relogin'}));
    assert.equal(fs.readFileSync(path.join(defaultHome, 'auth.json'), 'utf8'), defaultAuth);
    const made = await ask(plain, {action: 'restart'});
    assert.equal(made.status, 202, await made.clone().text());
    const {request} = await made.json() as {request: Request};
    const restarted = await decide(request, true);
    assert.equal(restarted.state, 'completed', JSON.stringify(restarted));
    assert.equal(restarted.result?.id, plain.name);
    await launchOf(plain.name);
    assert.equal(actualHome(pidOf(plain.name)), defaultHome, 'default remains default after another account was used');
    assert.equal(launches().findLast(fields => fields[2] === plain.name)?.[4], plain.token, 'restart stays in the same PTY');
    assert.equal(pidOf(work.name), workPid);
    assert.equal(actualHome(workPid), workHome);
    assert.equal(fs.readFileSync(path.join(defaultHome, 'auth.json'), 'utf8'), defaultAuth);
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
