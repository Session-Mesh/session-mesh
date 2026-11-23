// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
//
// Opt-in, native 2.3.2 development proof (MESH_OC_LINEAGE_BINARY; for the
// adapter path, also MESH_OC_LINEAGE_DRIVER built by dune). Every process
// has fresh private HOME/XDG/runtime and only the scripted loopback provider.
import assert from 'node:assert/strict';
import {execFileSync, spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {startFakeProvider} from './helpers/fake-openai-provider.ts';

type Session = {id: string; parentID?: string; fork?: {sessionID: string; boundary: unknown}};
type Export = {info: Session; messages: {id: string; type: string; text?: string; content?: unknown}[]};

const binary = process.env.MESH_OC_LINEAGE_BINARY && path.resolve(process.env.MESH_OC_LINEAGE_BINARY);
const validBinary = binary && fs.existsSync(binary);
const driver = process.env.MESH_OC_LINEAGE_DRIVER && path.resolve(process.env.MESH_OC_LINEAGE_DRIVER);
const ocamlTest = process.env.MESH_OC_LINEAGE_OCAML_TEST && path.resolve(process.env.MESH_OC_LINEAGE_OCAML_TEST);

async function server(binaryPath: string, root: string, work: string, providerPort: number,
  startupMs = 15_000, observeSpawn?: (child: ChildProcessWithoutNullStreams) => void) {
  for (const role of ['home', 'config', 'data', 'state', 'cache', 'runtime']) {
    fs.mkdirSync(path.join(root, role), {recursive: true, mode: 0o700});
    fs.chmodSync(path.join(root, role), 0o700);
  }
  const configDir = path.join(root, 'config', 'opencode');
  fs.mkdirSync(configDir, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({
    providers: {
      fixture: {
        name: 'Private scripted fixture',
        package: '@opencode/ai/providers/openai-compatible',
        settings: {baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: 'local-fixture'},
        models: {scripted: {name: 'Scripted fixture'}},
      },
    },
    model: 'fixture/scripted',
  }), {mode: 0o600});
  const password = randomBytes(24).toString('hex');
  const env = {
    PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime'), TMPDIR: root,
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
  };
  const child: ChildProcessWithoutNullStreams = spawn(binaryPath,
    ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {cwd: work, env});
  observeSpawn?.(child);
  let stderr = '';
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-2000); });
  const stop = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<void>(resolve => {
        timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2_000);
      })]);
      if (child.exitCode === null && child.signalCode === null) await exited;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let url: string;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onExit: (code: number | null) => void;
    let onError: (error: Error) => void;
    let onData: (bytes: Buffer) => void;
    url = await new Promise<string>((resolve, reject) => {
      let output = '';
      timer = setTimeout(() => reject(new Error(`server startup timeout: ${stderr}`)), startupMs);
      onExit = (code: number | null) => reject(new Error(`server exited ${code}: ${stderr}`));
      onError = (error: Error) => reject(error);
      onData = (bytes: Buffer) => {
        output += bytes.toString();
        const newline = output.indexOf('\n');
        if (newline < 0) return;
        try {
          const value = JSON.parse(output.slice(0, newline)) as {url: string};
          assert.match(value.url, /^http:\/\/127\.0\.0\.1:\d+$/);
          resolve(value.url);
        } catch (error) { reject(error); }
      };
      child.once('exit', onExit);
      child.once('error', onError);
      child.stdout.on('data', onData);
    }).finally(() => {
      if (timer) clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      child.stdout.off('data', onData);
    });
  } catch (error) {
    await stop();
    throw error;
  }
  const api = async (method: 'GET' | 'POST', route: string, body?: unknown) => {
    const response = await fetch(url + route, {
      method, signal: AbortSignal.timeout(15_000),
      headers: {Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    return {status: response.status, value: await response.json() as {data?: any; version?: string}};
  };
  return {api, close: stop};
}

test('native fork, import, resume, fork back with nonempty context', {skip: !validBinary}, async () => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mesh-oc-lineage-'));
  fs.chmodSync(scratch, 0o700);
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  let a: Awaited<ReturnType<typeof server>> | undefined;
  let b: Awaited<ReturnType<typeof server>> | undefined;
  const get = async (api: typeof a, route: string) => (await api!.api('GET', route)).value.data;
  const post = async (api: typeof a, route: string, body: unknown) => {
    const answer = await api!.api('POST', route, body);
    assert.equal(answer.status, 200, `${route}: ${JSON.stringify(answer.value)}`);
    return answer.value.data;
  };
  const settled = async (api: typeof a, id: string) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const active = await get(api, '/api/session/active') as Record<string, unknown>;
      const exported = await get(api, `/api/experimental/session/${id}/export`) as Export;
      if (!active[id] && exported.messages.at(-1)?.type === 'idle') return exported;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`session ${id} did not become idle`);
  };
  try {
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work, {mode: 0o700});
    provider = await startFakeProvider();
    a = await server(binary!, path.join(scratch, 'a'), work, provider.port);
    b = await server(binary!, path.join(scratch, 'b'), work, provider.port);
    assert.equal((await a.api('GET', '/api/info')).value.data?.version ?? (await a.api('GET', '/api/info')).value.version, '2.3.2');
    const root = await post(a, '/api/session', {location: {directory: work}});
    const s = root.id as string;
    await post(a, `/api/session/${s}/prompt`,
      {text: 'CANARY_INITIAL_USER [[execute: console.log("CANARY_INITIAL_TOOL")]]'});
    const initial = await settled(a, s);
    assert.ok(initial.messages.length >= 3, 'native transcript is nonempty');
    assert.ok(initial.messages.some(message => message.type === 'assistant'
      && JSON.stringify(message.content).includes('"status":"completed"')
      && JSON.stringify(message.content).includes('CANARY_INITIAL_TOOL')),
    'native assistant contains a completed real tool turn');
    const forkA = await post(a, `/api/session/${s}/fork`, {});
    assert.notEqual(forkA.id, s);
    assert.equal(forkA.fork?.sessionID, s, 'native fork records its source under fork.sessionID');
    const aFork = await settled(a, forkA.id);
    assert.ok(aFork.messages.length >= initial.messages.length, 'fork inherited native messages');
    assert.deepEqual(aFork.messages.map(({id: _, ...rest}) => rest),
      initial.messages.map(({id: _, ...rest}) => rest), 'native fork remaps IDs, not settled payload');
    assert.equal(aFork.info.fork?.sessionID, s);
    const importedFork = await post(b, '/api/experimental/session/import',
      {info: aFork.info, messages: aFork.messages, location: {directory: work}});
    assert.equal(importedFork.id, forkA.id);
    assert.equal(importedFork.fork, undefined, 'native import does not preserve fork metadata');
    const importedRoot = await post(b, '/api/experimental/session/import',
      {info: initial.info, messages: initial.messages, location: {directory: work}});
    assert.equal(importedRoot.id, s);
    const beforeB = provider.requests.length;
    await post(b, `/api/session/${forkA.id}/prompt`, {text: 'CANARY_B_INTERVENING_USER'});
    const bContinued = await settled(b, forkA.id);
    assert.ok(bContinued.messages.length > aFork.messages.length, 'B added real messages');
    const requestsB = provider.requests.slice(beforeB);
    assert.ok(requestsB.some(request => JSON.stringify(request).includes('CANARY_INITIAL_USER')));
    assert.ok(requestsB.some(request => JSON.stringify(request).includes('CANARY_INITIAL_TOOL')));
    assert.ok(requestsB.some(request => (request as {messages?: {role?: string; content?: unknown}[]}).messages
      ?.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('CANARY_INITIAL_TOOL'))),
    'B provider received the prior tool result as a tool message');
    assert.ok(requestsB.some(request => (request as {messages?: {role?: string}[]}).messages
      ?.some(message => message.role === 'assistant')), 'B provider received prior assistant turns');
    assert.ok(requestsB.some(request => JSON.stringify(request).includes('CANARY_B_INTERVENING_USER')));
    const forkB = await post(b, `/api/session/${forkA.id}/fork`, {});
    assert.equal(forkB.fork?.sessionID, forkA.id);
    const bFork = await settled(b, forkB.id);
    const importedBack = await post(a, '/api/experimental/session/import',
      {info: bFork.info, messages: bFork.messages, location: {directory: work}});
    assert.equal(importedBack.id, forkB.id);
    const beforeA = provider.requests.length;
    await post(a, `/api/session/${forkB.id}/prompt`, {text: 'CANARY_A_RETURN_USER'});
    const returned = await settled(a, forkB.id);
    assert.ok(returned.messages.length > bFork.messages.length, 'A appended a real turn');
    const requestsA = provider.requests.slice(beforeA);
    for (const canary of ['CANARY_INITIAL_USER', 'CANARY_INITIAL_TOOL', 'CANARY_B_INTERVENING_USER', 'CANARY_A_RETURN_USER']) {
      assert.ok(requestsA.some(request => JSON.stringify(request).includes(canary)), `returned provider input retains ${canary}`);
    }
    assert.ok(requestsA.some(request => (request as {messages?: {role?: string; content?: unknown}[]}).messages
      ?.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('CANARY_INITIAL_TOOL'))),
    'A provider received the earlier real tool result');
    assert.ok(requestsA.some(request => (request as {messages?: {role?: string}[]}).messages
      ?.some(message => message.role === 'assistant')), 'A provider received earlier assistant turns');
    assert.equal((await get(a, `/api/experimental/session/${s}/export`) as Export).info.id, s);
    assert.equal((await get(a, `/api/experimental/session/${forkA.id}/export`) as Export).info.id, forkA.id);
    console.log(JSON.stringify({nativeIDs: [s, forkA.id, forkB.id], messages: [
      initial.messages.length, aFork.messages.length, bContinued.messages.length, returned.messages.length],
    providerRequests: provider.requests.length, forkMetadata: [forkA.fork, importedFork.fork, forkB.fork, importedBack.fork]}));
  } finally {
    await b?.close();
    await a?.close();
    await provider?.close();
    fs.rmSync(scratch, {recursive: true, force: true});
  }
});

test('fixture startup failure stops only its child before returning', async () => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mesh-oc-startup-'));
  const children: ChildProcessWithoutNullStreams[] = [];
  const observe = (child: ChildProcessWithoutNullStreams) => { children.push(child); };
  const reaped = (child: ChildProcessWithoutNullStreams) =>
    child.exitCode !== null || child.signalCode !== null;
  try {
    const work = path.join(scratch, 'work');
    fs.mkdirSync(work, {mode: 0o700});
    const stalled = path.join(scratch, 'stalled');
    fs.writeFileSync(stalled, `#!${process.execPath}\nprocess.stdin.resume();\n`, {mode: 0o700});
    await assert.rejects(server(stalled, path.join(scratch, 'stalled-root'), work, 1, 80, observe),
      /startup timeout/);
    assert.equal(children.length, 1, 'observed the timed-out child directly');
    assert.ok(reaped(children[0]!), 'timed-out child exited before rejection');
    const malformed = path.join(scratch, 'malformed');
    fs.writeFileSync(malformed, `#!${process.execPath}\n` +
      `process.stdout.write('not json\\n'); process.stdin.resume();\n`, {mode: 0o700});
    await assert.rejects(server(malformed, path.join(scratch, 'malformed-root'), work, 1, 1_000, observe),
      /Unexpected token|not valid JSON/);
    assert.equal(children.length, 2, 'observed the malformed child directly');
    assert.ok(reaped(children[1]!), 'malformed child exited before rejection');
    const exits = path.join(scratch, 'exits');
    fs.writeFileSync(exits, `#!${process.execPath}\nprocess.exit(7);\n`, {mode: 0o700});
    await assert.rejects(server(exits, path.join(scratch, 'exits-root'), work, 1, 1_000, observe),
      /server exited 7/);
    assert.equal(children[2]!.exitCode, 7, 'observed the early-exit child');
    await assert.rejects(server(path.join(scratch, 'missing'), path.join(scratch, 'missing-root'), work, 1, 80, observe),
      /ENOENT/, 'spawn error rejects without an unhandled child error');
    assert.equal(children[3]!.pid, undefined, 'missing executable never started a child');
  } finally {
    for (const child of children) {
      if (child.pid && !reaped(child)) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill('SIGKILL');
        await exited;
      }
    }
    fs.rmSync(scratch, {recursive: true, force: true});
  }
});

test('native OCaml roundtrip removes only its target on success and refusal', {
  skip: !(validBinary && ocamlTest),
}, async () => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mesh-oc-target-cleanup-'));
  let host: Awaited<ReturnType<typeof server>> | undefined;
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  try {
    const root = path.join(scratch, 'source');
    const work = path.join(root, 'workspace');
    fs.mkdirSync(work, {recursive: true, mode: 0o700});
    provider = await startFakeProvider();
    host = await server(binary!, root, work, provider.port);
    const created = await host.api('POST', '/api/session', {location: {directory: work}});
    assert.equal(created.status, 200);
    const sessionID = created.value.data.id as string;
    const prompt = await host.api('POST', `/api/session/${sessionID}/prompt`,
      {text: 'CANARY [[execute: console.log("CANARY_TOOL")]]'});
    assert.equal(prompt.status, 200);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const active = (await host.api('GET', '/api/session/active')).value.data;
      const exported = (await host.api('GET', `/api/experimental/session/${sessionID}/export`)).value.data as Export;
      if (!active[sessionID] && exported.messages.at(-1)?.type === 'idle') break;
      assert.ok(Date.now() < deadline, 'scripted source became idle');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await host.close(); host = undefined;
    const run = (id: string) => execFileSync(ocamlTest!, ['test', 'adapter', '10'], {
      cwd: work, encoding: 'utf8', timeout: 30_000,
      env: {...process.env, MESH_OC_TRANSFER_BINARY: binary!, MESH_OC_TRANSFER_SOURCE: root,
        MESH_OC_TRANSFER_ID: id, MESH_OC_TRANSFER_EXPECTED: '4'},
    });
    run(sessionID);
    assert.deepEqual(fs.readdirSync(scratch), ['source'], 'successful transfer removed its target');
    assert.throws(() => run('ses_missingNativeSource'), 'refusal still cleans target');
    assert.deepEqual(fs.readdirSync(scratch), ['source'], 'failed transfer removed its target');
    assert.ok(fs.existsSync(path.join(root, 'data')), 'provided source remains untouched');
  } finally {
    await host?.close();
    await provider?.close();
    fs.rmSync(scratch, {recursive: true, force: true});
  }
});

test('adapter records two durable logical epochs while native IDs change', {
  skip: !(validBinary && driver),
}, async () => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mesh-oc-adapter-lineage-'));
  fs.chmodSync(scratch, 0o700);
  const work = path.join(scratch, 'work');
  const receipts = path.join(scratch, 'receipts');
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  let a: Awaited<ReturnType<typeof server>> | undefined;
  let b: Awaited<ReturnType<typeof server>> | undefined;
  const api = async (host: typeof a, method: 'GET' | 'POST', route: string, body?: unknown) => {
    const result = await host!.api(method, route, body);
    assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.value)}`);
    return result.value.data;
  };
  const idle = async (host: typeof a, id: string): Promise<Export> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const active = await api(host, 'GET', '/api/session/active') as Record<string, unknown>;
      const value = await api(host, 'GET', `/api/experimental/session/${id}/export`) as Export;
      if (!active[id] && value.messages.at(-1)?.type === 'idle') return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('fixture did not become idle');
  };
  const runAdapter = (source: string, target: string, parentID: string, epoch: number) => {
    const output = execFileSync(driver!, [binary!, path.join(scratch, source), path.join(scratch, target),
      work, receipts, parentID, String(epoch)], {
      cwd: work, env: {PATH: '/usr/bin:/bin', HOME: path.join(scratch, 'a', 'home'), TMPDIR: scratch},
      timeout: 25_000, encoding: 'utf8',
    });
    const result = JSON.parse(output) as {ok: boolean; native_id?: string; logical_id?: string; epoch?: number;
      parent_native_id?: string; code?: string};
    const refusal = fs.readdirSync(receipts).find(file => file.endsWith(`proof-epoch-${epoch}-refused`));
    const reason = refusal ? fs.readFileSync(path.join(receipts, refusal), 'utf8') : '';
    assert.equal(result.ok, true,
      `adapter refused: ${result.code}; phases=${fs.readdirSync(receipts).join(',')}; reason=${reason}`);
    assert.equal(result.epoch, epoch);
    assert.equal(result.parent_native_id, parentID);
    assert.equal(result.logical_id, 'mesh-logical-proof');
    return result.native_id!;
  };
  try {
    fs.mkdirSync(work, {mode: 0o700});
    fs.mkdirSync(receipts, {mode: 0o700});
    provider = await startFakeProvider();
    a = await server(binary!, path.join(scratch, 'a'), work, provider.port);
    b = await server(binary!, path.join(scratch, 'b'), work, provider.port);
    const root = await api(a, 'POST', '/api/session', {location: {directory: work}});
    const initialID = root.id as string;
    await api(a, 'POST', `/api/session/${initialID}/prompt`,
      {text: 'CANARY_ROOT_USER [[execute: console.log("CANARY_ROOT_TOOL")]]'});
    const initial = await idle(a, initialID);
    assert.ok(initial.messages.some(message => JSON.stringify(message.content ?? null).includes('"status":"completed"')));
    await a.close(); a = undefined;
    await b.close(); b = undefined;
    const onB = runAdapter('a', 'b', initialID, 1);
    assert.notEqual(onB, initialID);
    b = await server(binary!, path.join(scratch, 'b'), work, provider.port);
    const beforeB = provider.requests.length;
    await api(b, 'POST', `/api/session/${onB}/prompt`, {text: 'CANARY_B_INTERVENING'});
    const bTurn = await idle(b, onB);
    assert.ok(bTurn.messages.length > initial.messages.length);
    assert.ok(bTurn.messages.some(message => message.type === 'synthetic'),
      'restored notice was delivered as native context');
    assert.ok(provider.requests.slice(beforeB).some(request => (request as {messages?: {role?: string; content?: unknown}[]})
      .messages?.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('CANARY_ROOT_TOOL'))));
    assert.ok(provider.requests.slice(beforeB).some(request => JSON.stringify(request).includes('<fork-notice>')),
      'restored native fork notice reaches the B model input');
    await b.close(); b = undefined;
    const onA = runAdapter('b', 'a', onB, 2);
    assert.notEqual(onA, onB);
    b = await server(binary!, path.join(scratch, 'b'), work, provider.port);
    assert.deepEqual((await api(b, 'GET', `/api/experimental/session/${onB}/export`) as Export).messages,
      bTurn.messages, 'B original stays untouched after the return fork');
    await b.close(); b = undefined;
    a = await server(binary!, path.join(scratch, 'a'), work, provider.port);
    const beforeA = provider.requests.length;
    await api(a, 'POST', `/api/session/${onA}/prompt`, {text: 'CANARY_A_RETURN'});
    const aTurn = await idle(a, onA);
    assert.ok(aTurn.messages.length > bTurn.messages.length);
    const returnedBodies = provider.requests.slice(beforeA).map(request => JSON.stringify(request));
    for (const canary of ['CANARY_ROOT_USER', 'CANARY_ROOT_TOOL', 'CANARY_B_INTERVENING', 'CANARY_A_RETURN']) {
      assert.ok(returnedBodies.some(body => body.includes(canary)), `provider input retains ${canary}`);
    }
    assert.ok(provider.requests.slice(beforeA).some(request => (request as {messages?: {role?: string; content?: unknown}[]})
      .messages?.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('CANARY_ROOT_TOOL'))));
    assert.ok(provider.requests.slice(beforeA).some(request => JSON.stringify(request).includes('<fork-notice>')),
      'fork notices and earlier turns reach the return model input');
    assert.equal((await api(a, 'GET', `/api/experimental/session/${initialID}/export`) as Export).messages.length,
      initial.messages.length, 'original native session remains intact');
    const files = fs.readdirSync(receipts);
    assert.equal(files.length, 8, 'two create-only four-phase operation receipts');
    const imported = files.filter(file => file.endsWith('-imported')).map(file =>
      JSON.parse(fs.readFileSync(path.join(receipts, file), 'utf8')));
    assert.deepEqual(imported.map(row => row.epoch).sort(), [1, 2]);
    assert.deepEqual(imported.map(row => row.native_id).sort(), [onA, onB].sort());
    assert.deepEqual(imported.map(row => row.logical_id), ['mesh-logical-proof', 'mesh-logical-proof']);
    assert.ok(imported.some(row => row.epoch === 1 && row.parent_native_id === initialID
      && row.source_profile === 'a' && row.target_profile === 'b'));
    assert.ok(imported.some(row => row.epoch === 2 && row.parent_native_id === onB
      && row.source_profile === 'b' && row.target_profile === 'a'));
    for (const file of files) {
      assert.equal(fs.statSync(path.join(receipts, file)).mode & 0o777, 0o600,
        `durable phase ${file} stays private`);
    }
    console.log(JSON.stringify({nativeIDs: [initialID, onB, onA], messages: [
      initial.messages.length, bTurn.messages.length, aTurn.messages.length], receipts: files.length,
    providerRequests: provider.requests.length}));
  } finally {
    await b?.close();
    await a?.close();
    await provider?.close();
    fs.rmSync(scratch, {recursive: true, force: true});
  }
});

test('native completed summary remaps keepID on fork and imports; adapter refuses derived context', {
  skip: !(validBinary && driver),
}, async () => {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mesh-oc-compaction-'));
  fs.chmodSync(scratch, 0o700);
  const work = path.join(scratch, 'work');
  const receipts = path.join(scratch, 'receipts');
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  let source: Awaited<ReturnType<typeof server>> | undefined;
  let target: Awaited<ReturnType<typeof server>> | undefined;
  try {
    fs.mkdirSync(work, {mode: 0o700});
    fs.mkdirSync(receipts, {mode: 0o700});
    provider = await startFakeProvider({compactionSummary: '## Objective\n- Preserve the scripted conversation.'});
    source = await server(binary!, path.join(scratch, 'a'), work, provider.port);
    target = await server(binary!, path.join(scratch, 'b'), work, provider.port);
    const api = async (host: typeof source, method: 'GET' | 'POST', route: string, body?: unknown) => {
      const result = await host!.api(method, route, body);
      assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.value)}`);
      return result.value.data;
    };
    const idle = async (host: typeof source, id: string): Promise<Export> => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const active = await api(host, 'GET', '/api/session/active') as Record<string, unknown>;
        const result = await api(host, 'GET', `/api/experimental/session/${id}/export`) as Export;
        if (!active[id] && result.messages.at(-1)?.type === 'idle') return result;
        assert.ok(Date.now() < deadline, 'scripted compaction became idle');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const root = await api(source, 'POST', '/api/session', {location: {directory: work}});
    const parentID = root.id as string;
    await api(source, 'POST', `/api/session/${parentID}/prompt`, {text: 'CANARY_FIRST'});
    await idle(source, parentID);
    await api(source, 'POST', `/api/session/${parentID}/prompt`, {text: 'CANARY_SECOND'});
    await idle(source, parentID);
    await api(source, 'POST', `/api/session/${parentID}/compact`, {});
    const original = await idle(source, parentID);
    const compaction = original.messages.find(message => message.type === 'compaction') as
      ({id: string; status: string; metadata?: {keepID?: string}} | undefined);
    assert.equal(compaction?.status, 'completed', 'native completed summary');
    assert.ok(compaction.metadata?.keepID, 'native summary references kept parent message');
    assert.ok(original.messages.some(message => message.id === compaction.metadata!.keepID));
    const context = await api(source, 'GET', `/api/session/${parentID}/context`) as
      {type: string; id: string; metadata?: {recent?: string}}[];
    assert.equal(original.messages.at(-2)?.id, context[0]?.id);
    assert.ok(context[0]?.metadata?.recent, 'active context derives recent text from kept parent history');
    assert.notDeepEqual(context, original.messages.slice(-2),
      'the adapter must not silently ignore derived context metadata');
    await target.close(); target = undefined;
    await source.close(); source = undefined;
    const output = execFileSync(driver!, [binary!, path.join(scratch, 'a'), path.join(scratch, 'b'),
      work, receipts, parentID, '1'], {
      cwd: work, env: {PATH: '/usr/bin:/bin', HOME: path.join(scratch, 'a', 'home'), TMPDIR: scratch},
      timeout: 25_000, encoding: 'utf8',
    });
    const transferred = JSON.parse(output) as {ok: boolean; native_id?: string; code?: string};
    assert.equal(transferred.ok, false, 'adapter does not silently relax derived compaction context');
    assert.equal(transferred.code, 'transfer_unsupported_state');
    assert.deepEqual(fs.readdirSync(receipts), [], 'adapter refused before any fork or receipt');
    assert.deepEqual(context.map(message => message.type), ['compaction', 'idle']);
    source = await server(binary!, path.join(scratch, 'a'), work, provider.port);
    target = await server(binary!, path.join(scratch, 'b'), work, provider.port);
    const fork = await api(source, 'POST', `/api/session/${parentID}/fork`, {}) as Session;
    const child = await idle(source, fork.id);
    assert.equal(fork.fork?.sessionID, parentID);
    assert.equal(child.messages.length, original.messages.length);
    const suffixes = child.messages.map(message => {
      const match = /^(msg_[0-9a-zA-Z]{26})_([1-9][0-9]*)$/.exec(message.id);
      assert.ok(match, `fork child ID has pinned event-plus-seq shape: ${message.id}`);
      return {prefix: match[1], seq: BigInt(match[2]!)};
    });
    assert.equal(new Set(suffixes.map(row => row.prefix)).size, 1);
    assert.ok(suffixes.every((row, i) => i === 0 || row.seq > suffixes[i - 1]!.seq),
      'native child IDs increase by source row sequence');
    const before = child.messages.find(message => message.type === 'compaction') as
      ({id: string; status: string; metadata?: {keepID?: string}} | undefined);
    assert.equal(before?.status, 'completed');
    const index = original.messages.findIndex(message => message.id === compaction.metadata!.keepID);
    assert.ok(index >= 0);
    assert.equal(before.metadata?.keepID, child.messages[index]?.id, 'native fork maps exact kept position');
    assert.notEqual(before.metadata?.keepID, compaction.metadata!.keepID);
    const importResult = await api(target, 'POST', '/api/experimental/session/import',
      {info: child.info, messages: child.messages, location: {directory: work}}) as Session;
    assert.equal(importResult.id, fork.id);
    const imported = await api(target, 'GET',
      `/api/experimental/session/${fork.id}/export`) as Export;
    assert.deepEqual(imported.messages, child.messages, 'native import preserved remapped compaction');
    const mapped = imported.messages.find(message => message.type === 'compaction') as
      ({id: string; status: string; metadata?: {keepID?: string}} | undefined);
    assert.equal(mapped?.status, 'completed');
    assert.equal(mapped.metadata?.keepID, imported.messages[index]?.id, 'native fork maps exact kept position');
    assert.notEqual(mapped.metadata?.keepID, compaction.metadata!.keepID);
  } finally {
    await target?.close();
    await source?.close();
    await provider?.close();
    fs.rmSync(scratch, {recursive: true, force: true});
  }
});
