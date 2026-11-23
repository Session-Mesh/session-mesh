// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The real Mistral Vibe (3.1.2) in a real mesh, with a scripted model standing in for the provider
// (tests/fixtures/fake-openai-model.ts, declared in Vibe's configuration as a generic OpenAI-style provider).
// Own HOME (so Vibe's ~/.vibe, its session store and its trusted folders are the test's), own mesh, own PTY host.
// Needs MESH_VIBE_BIN (the `vibe` executable), MESH_BOARD_BIN (the built mesh-board-mcp) and MESH_CHROMIUM; skipped otherwise.
// Covered: the mesh-board tools are visible to the model and answer, a permission and its state, the mailbox with the
// user's consent, the wake notice typed at the idle prompt, the conversation restored after a PTY host restart,
// the session token absent from every command line and file, and no process left behind.
import assert from 'node:assert/strict';
import {type ChildProcess, execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {after, before, describe, test} from 'node:test';
import type {Page} from 'playwright-core';
import {REPO, settle, skip, TerminalMesh} from './terminal-browser-lib.ts';

const VIBE = process.env.MESH_VIBE_BIN ?? '';
const BOARD = process.env.MESH_BOARD_BIN ?? '';
const absent = !VIBE || !BOARD ? 'MESH_VIBE_BIN or MESH_BOARD_BIN not set' : skip;
type Pane = {term: {buffer: {active: {type: string; length: number; getLine(y: number): {translateToString(trim: boolean): string} | undefined}};
  modes: {mouseTrackingMode: string; bracketedPasteMode: boolean}; paste(text: string): void}; send(text: string): void};
declare const active: Pane;

let mesh: TerminalMesh;
let model: ChildProcess;
let requests: string;
let work: string;

const lines = (): {tools: string[]; role: string; text: string}[] =>
  fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const screen = (page: Page): Promise<string> => page.evaluate(() => {
  const buffer = active.term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y++) rows.push(buffer.getLine(y)!.translateToString(true));
  return rows.join('\n');
});
async function until<T>(what: string, probe: () => Promise<T | undefined | false>, attempts = 200): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const say = async (page: Page, text: string) => {
  await page.evaluate(line => active.send(line), text);
  await page.waitForTimeout(300);
  await page.evaluate(() => active.send('\r'));
};
/** Vibe asks before every MCP call (its default): answer the prompt with its first choice, "Allow once". */
const approve = async (page: Page) => {
  await until('an approval prompt', async () => (await screen(page)).includes('Allow once') || undefined);
  await page.waitForTimeout(800);   // the prompt takes its keys only once it is focused
  await page.evaluate(() => active.send('\r'));
};
/** Wait for Vibe to be idle, answering the approval prompts that come up meanwhile (a wake notice makes it call mail.inbox). */
async function untilIdle(page: Page, name: string): Promise<void> {
  let quiet = 0;
  await until(`${name} to be idle`, async () => {
    if ((await screen(page)).includes('Allow once')) {
      await page.waitForTimeout(800);
      await page.evaluate(() => active.send('\r'));
      quiet = 0;
      return undefined;
    }
    quiet = (await agentOf(name))?.status === 'idle' ? quiet + 1 : 0;
    return quiet >= 3 || undefined;
  }, 300);
}
const api = (route: string, init: RequestInit = {}) => fetch(`${mesh.base}${route}`, {...init,
  headers: {Authorization: `Bearer ${mesh.token()}`, Origin: mesh.base, 'Content-Type': 'application/json'}});
type Listed = {mesh: {id: string; created: number; agent: {type: string; status?: string; waiting_for?: string; session_id?: string; pid: number} | null}[];
  restorable: {name: string; resumable: boolean}[]};
const listing = async () => await (await api('/api/sessions')).json() as Listed;
const agentOf = async (name: string) => (await listing()).mesh.find(item => item.id === name)?.agent;

async function ownerCookie(): Promise<string> {
  const response = await fetch(`${mesh.base}/login?token=${encodeURIComponent(mesh.token())}`, {redirect: 'manual'});
  return response.headers.getSetCookie().find(item => item.startsWith('mesh_auth='))!.split(';')[0].slice('mesh_auth='.length);
}
const owner = async (route: string, init: RequestInit = {}) => fetch(`${mesh.base}${route}`, {...init,
  headers: {Origin: mesh.base, Cookie: `mesh_auth=${await ownerCookie()}`, 'Content-Type': 'application/json'}});

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const {port} = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  if (absent) return;
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'vr-'));
  requests = path.join(scratch, 'requests.log');
  const meshBin = path.join(scratch, 'meshbin');
  fs.mkdirSync(meshBin);
  fs.copyFileSync(BOARD, path.join(meshBin, 'mesh-board-mcp'));
  fs.chmodSync(path.join(meshBin, 'mesh-board-mcp'), 0o755);
  fs.symlinkSync(path.join(REPO, 'bin', 'mesh-event'), path.join(meshBin, 'mesh-event'));
  const port = await freePort();
  model = spawn(process.execPath, ['--experimental-strip-types', path.join(REPO, 'tests', 'fixtures', 'fake-openai-model.ts'), String(port), requests],
    {stdio: 'ignore'});
  mesh = new TerminalMesh({MESH_BIN_DIR: meshBin, PATH: `${path.dirname(VIBE)}:${process.env.PATH}`});
  await mesh.start();
  work = path.join(mesh.home, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(mesh.home, '.vibe'), {mode: 0o700});
  fs.writeFileSync(path.join(mesh.home, '.vibe', 'config.toml'), `active_model = "fake"
enable_telemetry = false
enable_update_checks = false
enable_auto_update = false
enable_notifications = false

[[providers]]
name = "fakeprov"
api_base = "http://127.0.0.1:${port}/v1"
api_style = "openai"
backend = "generic"

[[models]]
name = "fake-model"
provider = "fakeprov"
alias = "fake"
`);
});

let stopped = false;
/** Vibe leaves read-only directories in its plugin store: make the scratch removable, then stop the mesh. */
async function stopMesh(): Promise<void> {
  if (stopped) return;
  stopped = true;
  execFileSync('chmod', ['-R', 'u+rwX', mesh.scratch]);
  await mesh.stop();
}

after(async () => {
  model?.kill('SIGKILL');
  if (mesh) await stopMesh();
});

async function launch(name: string): Promise<Page> {
  const response = await api('/api/new', {method: 'POST', body: JSON.stringify({preset: 'vibe', cwd: work, name})});
  assert.equal(response.status, 200, await response.clone().text());
  const page = await mesh.openPage(name, {width: 1100, height: 700});
  await until(`${name} to show its prompt`, async () => (await screen(page)).includes('Type /help') || undefined);
  return page;
}

describe('real Vibe', {skip: absent}, () => {
  let a: Page;
  let b: Page;
  let inboxId = '';

  test('the mesh-board tools are visible to the model and answer', async () => {
    a = await launch('vb-a');
    b = await launch('vb-b');
    await settle(a);
    await say(a, 'CALL mail {"action":"peers"}');
    await approve(a);
    const result = await until('the peers result', async () => lines().find(line => line.role === 'tool' && line.text.includes('vb-b')))
      .catch(async (error: Error) => { throw new Error(`${error.message}\n${await screen(a)}\n${mesh.output.slice(-1500)}`); });
    assert.ok(result.text.includes('vb-b'), 'the peer list reaches the model as text');
    // Vibe 3.1 gives the model its MCP servers through a sandbox (run_typescript, tools.mcp_mesh_board.*), not as tools.
    assert.ok(lines().some(line => line.tools.includes('run_typescript') && line.tools.includes('search_tool_functions')));
  });

  test('a permission prompt is reported as waiting for a permission, and work resumes after the answer', async () => {
    await until('idle after the first turn', async () => (await agentOf('vb-a'))?.status === 'idle' || undefined);
    // A write outside the working folder asks for a permission (bash and edits inside it do not, in Vibe's default agent).
    await say(a, `CALL write_file {"path":"${path.join(mesh.home, 'approved-run.txt')}","content":"approved-run"}`);
    const waiting = await until('a permission wait', async () => {
      const agent = await agentOf('vb-a');
      return agent?.waiting_for === 'permission prompt' ? agent : undefined;
    });
    assert.equal(waiting.type, 'vibe');
    await approve(a);
    await until('the file to be written', async () => fs.existsSync(path.join(mesh.home, 'approved-run.txt')) || undefined);
    await until('idle again', async () => (await agentOf('vb-a'))?.status === 'idle' || undefined);
  });

  test('a message to an idle Vibe types a one-line notice, and its text is read only after the user agrees', async () => {
    const created = (await listing()).mesh.find(item => item.id === 'vb-a')!.created;
    await say(b, `CALL mail {"action":"send","arguments":{"target":"vb-a","target_created":${created},"kind":"message","text":"ping-xyz-123"}}`);
    await approve(b);
    await until('the notice typed into vb-a', async () => {
      const output = await screen(a);
      return output.includes('# Mesh: new message') && output.includes('mail.inbox') || undefined;
    });
    await approve(a);
    const inbox = await until('the inbox result', async () => lines().find(line => line.role === 'tool' && line.text.includes('"messages"')
      && line.text.includes('"id"')));
    inboxId = /"id":"([^"]+)"/.exec(inbox.text)![1];
    assert.ok(!inbox.text.includes('ping-xyz-123'), 'the inbox lists no message text');
    assert.ok(!(await screen(a)).includes('ping-xyz-123'), 'the message text never reached the terminal');
    await untilIdle(a, 'vb-a');
    await say(a, `CALL mail {"action":"read","arguments":{"message_id":"${inboxId}"}}`);
    await approve(a);
    const pending = await until('a consent request', async () => {
      const consent = await (await owner('/api/agent-mail/consent')).json() as {requests?: {id: string}[]};
      return consent.requests?.[0];
    });
    const decision = await owner(`/api/agent-mail/consent/${pending.id}/decision`, {method: 'POST', body: JSON.stringify({decision: 'yes'})});
    assert.equal(decision.status, 200, await decision.clone().text());
    await untilIdle(a, 'vb-a');
    await say(a, `CALL mail {"action":"read","arguments":{"message_id":"${inboxId}"}}`);
    await approve(a);
    await until('the message text', async () => lines().find(line => line.role === 'tool' && line.text.includes('ping-xyz-123')));
  });

  test('the terminal: alternate screen with mouse reports, and a multi-line paste is one bracketed block, not submitted', async () => {
    await untilIdle(a, 'vb-a');
    const modes = await a.evaluate(() => [active.term.buffer.active.type, active.term.modes.mouseTrackingMode, active.term.modes.bracketedPasteMode]);
    assert.deepEqual(modes, ['alternate', 'any', true]);
    const submitted = lines().length;
    await a.evaluate(() => active.term.paste('paste-line-one\npaste-line-two'));
    await until('both pasted lines in the prompt', async () => {
      const text = await screen(a);
      return (text.includes('paste-line-one') && text.includes('paste-line-two')) || undefined;
    });
    await a.waitForTimeout(1000);
    assert.equal(lines().length, submitted, 'a newline inside a bracketed paste is not an Enter');
    await a.evaluate(() => active.send('\x15'));   // Ctrl-U: clear the prompt
  });

  test('the session token is in no command line and in no file, Vibe\'s own session store included', async () => {
    const agent = (await agentOf('vb-a'))!;
    const token = /MESH_SESSION_TOKEN=([^\0]+)/.exec(fs.readFileSync(`/proc/${agent.pid}/environ`, 'latin1'))![1];
    const holders: string[] = [];
    for (const entry of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
      try {
        if (fs.readFileSync(`/proc/${entry}/cmdline`, 'latin1').includes(token)) holders.push(`cmdline of ${entry}`);
      } catch { /* gone */ }
    }
    const walk = (dir: string): void => {
      for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) walk(file);
        else if (item.isFile() && fs.readFileSync(file, 'latin1').includes(token)) holders.push(file);
      }
    };
    walk(mesh.home);
    assert.deepEqual(holders, []);
  });

  test('after a PTY host restart the same conversation is restored and shows its history', async () => {
    const before = (await agentOf('vb-a'))!;
    assert.match(before.session_id ?? '', /^[0-9a-f-]{36}$/);
    await mesh.restartHost();
    const restorable = await until('the lost session offered', async () =>
      (await listing()).restorable.find(item => item.name === 'vb-a'));
    assert.equal(restorable.resumable, true);
    const restored = await api('/api/restore', {method: 'POST', body: JSON.stringify({names: ['vb-a']})});
    assert.equal(restored.status, 200, await restored.clone().text());
    const page = await mesh.openPage('vb-a', {width: 1100, height: 700});
    await until('the history of the conversation', async () => (await screen(page)).includes(`Resumed session ${before.session_id!.slice(-8)}`) && (await screen(page)).includes('ping-xyz-123') || undefined, 300)
      .catch(async (error: Error) => { throw new Error(`${error.message} (before: ${JSON.stringify(before)})\n${await screen(page)}\n${JSON.stringify(await agentOf('vb-a'))}`); });
    const after = await until('the same conversation', async () => {
      const agent = await agentOf('vb-a');
      return agent?.session_id === before.session_id ? agent : undefined;
    });
    assert.equal(after.type, 'vibe');
    await settle(page);
    await say(page, 'CALL mail {"action":"peers"}');
    await approve(page);
    await until('the board again after the restore', async () => lines().filter(line => line.role === 'tool' && line.text.includes('vb-b')).length >= 2 || undefined);
  });

  test('stopping the mesh leaves no Vibe process behind', async () => {
    await stopMesh();
    const remaining = (): string[] => fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(pid => {
      try {
        return fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(mesh.scratch) || fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(mesh.scratch);
      } catch { return false; }
    });
    // The processes end asynchronously after the stop (their pseudo-terminals close, then they get a hangup): wait for
    // them up to 10 s, polling every 200 ms. A process that survives the delay still fails the test.
    const deadline = Date.now() + 10_000;
    let left = remaining();
    while (left.length > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
      left = remaining();
    }
    assert.deepEqual(left, []);
  });
});
