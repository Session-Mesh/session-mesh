// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Black-box HTTP harness: starts the web server as a separate process in a throwaway environment
// (its own HOME, config, cache and runtime directories, on a free loopback port) and exposes only what
// a client can observe over HTTP: the master token file, the cookie, and requests, their statuses and bodies.
// It never imports or inspects server internals, so the same checks can later be pointed at another
// implementation of the same HTTP surface (SERVER_COMMAND below). The route table is read as text from
// tests/test_route_auth_table.py (its EXPECTED dictionary). Each failure starts with the kind of change seen (changeLabel() alone):
//  - AUTH-BOUNDARY: a credential crossed a boundary its class closes, or was stopped where its class lets it
//    through (401, the redirect to /login, or the bare 403 that carries no handler text).
//  - BUSINESS-STATUS: the credential was treated as its class says, but the handler answered something else
//    than the golden answer below. A 404 or 405 of either kind also asks whether the route is still served.
// The handler statuses are expected to hold behind a front-end that relays to the same handlers. The answers
// the framework gives by itself (FRAMEWORK_ANSWERS below: the middleware's bare refusals, 405 with its Allow
// list, HEAD wherever GET is served, the redirect to /login) come from the auth middleware and the router,
// not from a handler: a replacement front-end must reproduce them byte for byte, or they are updated
// deliberately in that one constant, in the same change. There is no other per-implementation override.
import assert from 'node:assert/strict';
import {type ChildProcess, spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {installFakeClaude, MANAGED} from './claude-wake-lib.ts';
import {ptyhostArgv} from './ptyhost-command.ts';

export const REPO = path.resolve(import.meta.dirname, '..');
export const ROUTE_TABLE_FILE = path.join(REPO, 'tests', 'test_route_auth_table.py');
const PYTHON = process.env.MESH_PYTHON || 'python3';
// The command that starts the server under test; the tests only need it to listen on MESH_PORT.
const SERVER_COMMAND = (process.env.MESH_HARNESS_SERVER_COMMAND || `${PYTHON} server.py`).trim().split(/\s+/);
/** The live agent session started when a PTY host is available. */
const SESSION_NAME = 'alpha';

// ---------------------------------------------------------------- the route table

export const CLASSES = ['public', 'cookie', 'cookie-only', 'session', 'session-only'] as const;
// The constants the Python file names them by, in the same order (its declaration is checked against both
// lists in http-route-table.test.ts).
export const CLASS_NAMES = ['PUBLIC', 'COOKIE', 'COOKIE_ONLY', 'SESSION', 'SESSION_ONLY'];
export type RouteClass = (typeof CLASSES)[number];
export type Route = {method: string; canonical: string; klass: RouteClass; path: string};

const PLACEHOLDER = /\{[a-z_]+(?::[^}]*)?\}/g;
// Paths that name something real, so that the answer proves the handler ran: two vendored files (an
// unserved /viewlib answers 404, these answer 200), the board of the live session (404 for any other name), and
// three @self routes with a query (without it, the bare 400 the {name} route of the same shape gives "@self").
const CONCRETE: Record<string, string> = {
  '/static': '/static/app.js',
  '/viewlib/{name}': '/viewlib/marked.min.js',
  '/viewlib/monaco/{tail}': '/viewlib/monaco/LICENSE',
  '/api/board/{name}': `/api/board/${SESSION_NAME}`,
  '/api/board/{name}/revisions': `/api/board/${SESSION_NAME}/revisions`,
  '/api/board/@self/revision': '/api/board/@self/revision?version=0',
  '/api/board/@self/revision/diff': '/api/board/@self/revision/diff?from_version=0&to_version=0',
  '/api/demo-scene/@self/selected/revisions': '/api/demo-scene/@self/selected/revisions?demo_id=x',
  // The account reads refuse any query before running mesh-profile, so the answer does not depend on the helper.
  '/api/accounts/profiles': '/api/accounts/profiles?probe=1',
  '/api/accounts/consent': '/api/accounts/consent?probe=1',
  // The flow read also refuses a query before starting its optional journal helper.
  '/api/flow/events': '/api/flow/events?probe=1',
};

// A concrete request path for a canonical resource: other placeholders take a value nothing has.
export function concretePath(canonical: string): string {
  return CONCRETE[canonical] ?? canonical.replace(PLACEHOLDER, 'x');
}

/** The EXPECTED dictionary of the Python route table, parsed as text (no Python is run). */
export function parseRouteTable(source: string): Route[] {
  const start = source.indexOf('EXPECTED = {');
  if (start < 0) throw new Error('EXPECTED = { not found in the route table file');
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error('end of EXPECTED not found in the route table file');
  const routes: Route[] = [];
  const seen = new Set<string>();
  for (const line of source.slice(start, end).split('\n').slice(1)) {
    const code = line.replace(/\s+#.*$/, '').trim();
    if (code === '' || code.startsWith('#')) continue;
    const entry = /^\("([A-Z]+)", "([^"]+)"\): ([A-Z_]+),$/.exec(code);
    if (entry === null) throw new Error(`unparsed line in EXPECTED: ${line}`);
    const klass = CLASSES[CLASS_NAMES.indexOf(entry[3]!)];
    if (klass === undefined) throw new Error(`unknown class ${entry[3]} in EXPECTED: ${line}`);
    const key = `${entry[1]} ${entry[2]}`;
    if (seen.has(key)) throw new Error(`duplicate route in EXPECTED: ${key}`);
    seen.add(key);
    routes.push({method: entry[1]!, canonical: entry[2]!, klass, path: concretePath(entry[2]!)});
  }
  return routes;
}

export function readRouteTable(): Route[] {
  return parseRouteTable(fs.readFileSync(ROUTE_TABLE_FILE, 'utf8'));
}

export const routesOf = (routes: Route[], ...classes: RouteClass[]): Route[] =>
  routes.filter(route => classes.includes(route.klass));
export const label = (route: Route): string => `${route.method} ${route.canonical} [${route.klass}]`;
export const routeKey = (route: Route): string => `${route.method} ${route.canonical}`;

// ---------------------------------------------------------------- the expected answers (golden tables)

// The exact status a route answers when its credential is accepted, for the safe request observe() makes (a JSON
// array body, or no body for an upload), with a PTY host and its live session. An optional text after the status
// must appear in the body: it tells a handler's 403 from the middleware's bare one, and an @self handler's 400
// from the bare 400 of the {name} route that would answer in its place. A method the server refuses (405), a
// crash (5xx) or a path it does not serve (404) fails the run; http-route-table.test.ts explains every 403 and
// 404 cell and lists the blind ones (BLIND_CELLS).
// The server is started with MESH_ANSWER_BUTTONS=1 (see isolatedEnvironment): POST /api/push/act then reads its
// body (400) instead of answering 403 "Answer buttons disabled" to every caller.
// POST /login is public but is not here: it is checked on its own (a wrong token redirects to /login?bad=1).
const ACCEPTED_STATUS = `
  GET / 200
  GET /static 200
  GET /login 200
  GET /favicon.svg 200
  GET /manifest.webmanifest 200
  GET /sw.js 200
  GET /view/{tail} 403
  GET /viewlib/monaco/{tail} 200
  GET /viewlib/{name} 200
  GET /api/restore/rebind 200
  GET /api/sessions 200
  GET /api/portfolio/diff/{selector} 404
  GET /api/dirs 200
  POST /api/dirs/recent 400
  POST /api/projects/v1 400
  POST /api/work/v1 400
  POST /api/projects/artifacts/v1 400
  POST /api/projects/issues/v1 400
  GET /api/docs 200
  GET /api/history 200
  GET /api/history/search 200
  GET /api/history/{agent}/{sid} 400
  DELETE /api/history/{agent}/{sid} 400
  POST /api/history/resume 400
  GET /api/push/key 200
  POST /api/push/subscribe 400
  POST /api/push/unsubscribe 400
  POST /api/push/detail 400
  POST /api/push/act 400
  POST /api/logout 200
  POST /api/new 400
  POST /api/adopt 400
  POST /api/kill/{name} 400
  GET /api/demo-scene/{name} 400
  GET /api/demo-scene/{name}/catalog 400
  GET /api/demo-scene/{name}/selected 400
  GET /api/demo-scene/{name}/selected/revisions 400
  POST /api/demo-scene/{name}/selected/restore 400
  GET /demo-scene/{name}/{version} 400
  GET /demo-scene/{name}/{demo_id}/{version} 400
  GET /api/board/{name} 200
  PUT /api/board/{name} 400
  GET /api/board/{name}/revisions 200
  GET /api/board/{name}/revision 400
  GET /api/board/{name}/revision/diff 400
  POST /api/board/{name}/revision/restore 400
  POST /api/session-actions/{request_id}/claim 400
  POST /api/session-actions/{request_id}/recover-fence 400
  POST /api/session-actions/{request_id}/decision 400
  POST /api/organize 400
  POST /api/restore/rebind 400
  POST /api/restore 400
  POST /api/restore/discard 400
  POST /api/upload 400
  POST /api/view 400
  POST /api/ls 400
  POST /api/external-open 400
  GET /ws/{name} 400
  GET /api/agent-mail/consent 200
  GET /api/agent-mail/overview 200
  GET /api/agent-mail/messages 400
  GET /api/flow/events 400
  GET /api/update/notes 404 no release notes
  GET /api/update/image 400
  GET /api/config 200
  POST /api/config/elevate 400
  POST /api/config/elevate/revoke 400
  POST /api/config/launch 403 elevation-required
  POST /api/config/launch-options 403 elevation-required
  POST /api/agent-mail/consent/{request_id}/decision 400
  POST /api/agent-mail/consent/revoke 400
  GET /api/accounts/profiles 400 invalid-request
  POST /api/accounts/profiles/create 400 invalid-request
  GET /api/accounts/consent 400 invalid-request
  POST /api/accounts/consent/set-global 400 invalid-request
  POST /api/accounts/profiles/provision 400 invalid-request
  POST /api/accounts/consent/set-pair 400 invalid-request
  POST /api/accounts/consent/remove-pair 400 invalid-request
  POST /api/accounts/consent/reset 400 invalid-request
  POST /api/open 400
  POST /api/stat 400
  GET /api/board/@self 200
  PUT /api/board/@self 400 JSON object expected
  GET /api/board/@self/revisions 200
  GET /api/board/@self/revision 200
  GET /api/board/@self/revision/diff 200
  GET /api/board/@self/latest-change 200
  POST /api/board/@self/open 400
  POST /api/board/@self/refresh 400
  POST /api/board/@self/revision/restore 400 JSON object expected
  GET /api/demo-scene/@self 200
  PUT /api/demo-scene/@self 400
  GET /api/demo-scene/@self/revisions 200
  POST /api/demo-scene/@self/open 400
  POST /api/demo-scene/@self/open-named 400
  GET /api/demo-scene/@self/catalog 200
  POST /api/demo-scene/@self/catalog 400
  GET /api/demo-scene/@self/selected 400 Demo ID required
  PUT /api/demo-scene/@self/selected 400
  GET /api/demo-scene/@self/selected/revisions 400 Invalid demo ID
  POST /api/demo-scene/@self/selected/restore 400 Invalid demo restore
  GET /api/agent-mail/@self/peers 200
  GET /api/agent-mail/@self/inbox 200
  POST /api/agent-mail/@self/read 400
  POST /api/agent-mail/@self/send 400
  POST /api/agent-mail/@self/reply 400
  POST /api/agent-mail/@self/ack 400
  GET /api/agent-mail/@self/pi-wakes 403 Only agent sessions can use messaging
  POST /api/agent-mail/@self/pi-wake-ack 403 Only agent sessions can use messaging
  GET /api/session-actions/@self/request 400
  POST /api/session-actions/@self/request 400
  GET /api/session-actions/@self/accounts 200
  POST /api/event 400
  POST /api/logout-all 200
`;

// Without a PTY host, the routes that look sessions up answer 503 (the host is not responding) instead.
const NO_HOST_STATUS = `
  GET /api/board/{name} 503
  GET /api/board/{name}/revisions 503
  GET /api/agent-mail/overview 503
`;

// The routes whose session cell uses the token of a plain (non-agent) session, which their handler refuses by name.
const PLAIN_SESSION_ROUTES = new Set(['GET /api/agent-mail/@self/pi-wakes', 'POST /api/agent-mail/@self/pi-wake-ack']);

export type Cell = {status: number; body: string | null};

export function expectedStatusTable(text: 'host' | 'no-host' = 'host'): Map<string, Cell> {
  const table = new Map<string, Cell>();
  const source = text === 'host' ? ACCEPTED_STATUS : NO_HOST_STATUS;
  for (const line of source.split('\n').map(entry => entry.trim()).filter(entry => entry !== '')) {
    const match = /^([A-Z]+ \S+) (\d{3})(?: (.+))?$/.exec(line);
    if (match === null) throw new Error(`unparsed line in the expected status table: ${line}`);
    if (table.has(match[1]!)) throw new Error(`duplicate in the expected status table: ${match[1]}`);
    table.set(match[1]!, {status: Number(match[2]), body: match[3] ?? null});
  }
  return table;
}

const STATUS_TABLE = expectedStatusTable('host');
const NO_HOST_TABLE = expectedStatusTable('no-host');

/** The answer of a route for a credential its class accepts, with or without a PTY host. */
export function acceptedCell(route: Route, hostPresent: boolean = hostAvailable()): Cell {
  const cell = (!hostPresent && NO_HOST_TABLE.get(routeKey(route))) || STATUS_TABLE.get(routeKey(route));
  if (cell === undefined) throw new Error(`no expected status for ${routeKey(route)}: classify it in http-harness.ts`);
  return cell;
}

/** The answers the framework (auth middleware and router) gives with no handler text: the one place that pins them. */
export const FRAMEWORK_ANSWERS = {
  bare: {400: '400: Bad Request', 401: '401: Unauthorized', 403: '403: Forbidden', 404: '404: Not Found', 405: '405: Method Not Allowed'},
  loginRedirect: '/login',
  allow: (methods: string[]): string => [...methods, ...(methods.includes('GET') ? ['HEAD'] : [])].sort().join(','),
};

/** What a client with no credential (or a refused one) meets: a redirect to /login on pages, 401 elsewhere. */
export function refusal(route: Route, credential: Credential): Observed {
  const page = !route.path.startsWith('/api') && !route.path.startsWith('/ws');
  return credential === 'none' && page ? {status: 302, location: FRAMEWORK_ANSWERS.loginRedirect} : {status: 401, location: null};
}

// ---------------------------------------------------------------- the server process

export type Mesh = {
  base: string;
  home: string;
  token: string; // the master token, read from the config directory like the CLI does
  cookie: string; // the `Cookie` header value of an owner browser at cookie generation 0
  sessionToken: string | undefined; // tokens of a live agent session (SESSION_NAME) and of a plain one, with a PTY host
  plainSessionToken: string | undefined;
  hostPresent: boolean;
  stop: () => Promise<void>;
};

/**
 * Why session-token checks cannot run here, or false when they can. A missing PTY host is not a reason to
 * skip: ptyhostArgv() throws (MESH_PTYHOST_CMD, else mesh-ptyhost on PATH; CONTRIBUTING.md), so the run fails.
 */
export function sessionSkipReason(): string | false {
  ptyhostArgv();
  if (MANAGED.length > 0) return `SKIPPED: managed Claude settings at ${MANAGED[0]} change what a Claude session does`;
  return false;
}

/** Whether startMesh starts a PTY host (the suites ask for one exactly when session checks can run). */
export const hostAvailable = (): boolean => sessionSkipReason() === false;

function accepts(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port}, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

// A loopback port nothing listens on, searched from one derived from the process id: a port the system picks
// may be handed to both test files before either server has bound it (the second then talks to the first).
async function freePort(): Promise<number> {
  for (let port = 20000 + process.pid % 10000; ; port++) if (!(await accepts(port))) return port;
}

async function waitFor(what: string, timeoutMs: number, done: () => boolean | Promise<boolean>): Promise<void> {
  const start = performance.now();
  while (!(await done())) {
    if (performance.now() - start > timeoutMs) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function isolatedEnvironment(home: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env};
  // A developer's own agent data locations would point the server at real conversations.
  for (const name of ['XDG_DATA_HOME', 'OPENCODE_DB', 'COPILOT_HOME', 'VIBE_HOME', 'GEMINI_CLI_HOME',
    'PI_CODING_AGENT_DIR']) delete env[name];
  // Every MESH_* variable configures the server (MESH_TRUST_PROXY, MESH_PUSH, MESH_HISTORY_CMD, and
  // MESH_SESSION / MESH_SESSION_TOKEN when the suite itself runs inside a session): none may leak in.
  for (const name of Object.keys(env)) if (name.startsWith('MESH_')) delete env[name];
  return {...env, HOME: home, XDG_RUNTIME_DIR: path.join(home, 'run'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    MESH_CONF_DIR: path.join(home, '.config', 'session-mesh'), MESH_CACHE_DIR: path.join(home, '.cache', 'session-mesh'),
    MESH_PORT: String(port),
    // The owner's switch for answering from a notification. With it, POST /api/push/act reaches its body check;
    // no push subscription exists here, so no notification carries an answer.
    MESH_ANSWER_BUTTONS: '1'};
}

async function killAndWait(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill(signal);
  await closed;
}

// Start a child (added to `children`, which `stop` kills) and wait until it is ready; a spawn error or an early
// exit fails the start with the child's output.
async function startChild(what: string, argv: string[], env: NodeJS.ProcessEnv, children: ChildProcess[],
                          ready: () => boolean | Promise<boolean>): Promise<void> {
  const [program, ...args] = argv;
  const child = spawn(program!, args, {cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe']});
  children.push(child);
  let output = '';
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await waitFor(what, 20000, async () => {
    if (spawnError !== undefined) throw new Error(`cannot start ${what} (${argv.join(' ')}): ${spawnError.message}`);
    if (child.exitCode !== null) throw new Error(`${what} exited (${child.exitCode}):\n${output}`);
    return ready();
  });
}

/** Start the server (and, when asked, the PTY host with two live sessions). Everything is stopped by `stop`. */
export async function startMesh(options: {session: boolean}): Promise<Mesh> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'http-harness-'));
  const home = path.join(scratch, 'home');
  fs.mkdirSync(path.join(home, 'run'), {recursive: true, mode: 0o700});
  const port = await freePort();
  const env = isolatedEnvironment(home, port);
  // A session the server recognises as an agent (the mail and session-action routes refuse a plain shell).
  const fake = options.session ? installFakeClaude() : undefined;
  if (fake !== undefined) Object.assign(env, {PATH: fake.PATH, MESH_BIN_DIR: fake.MESH_BIN_DIR});
  const children: ChildProcess[] = [];
  const stop = async (): Promise<void> => {
    for (const child of children.reverse()) await killAndWait(child, 'SIGKILL');
    // A session shell of the killed PTY host writes its history into the home as it dies: remove until gone.
    try {
      await waitFor('the removal of the temporary home', 5000, () => {
        try { fs.rmSync(scratch, {recursive: true, force: true}); } catch (error) { if (!/ENOTEMPTY/.test(String(error))) throw error; }
        return !fs.existsSync(scratch);
      });
    } finally { if (fake !== undefined) fs.rmSync(fake.bin, {recursive: true, force: true}); }
  };
  try {
    if (fake !== undefined) {
      const socket = path.join(home, 'run', 'session-mesh', 'ptyhost.sock');
      await startChild('the PTY host', ptyhostArgv(),
        {PATH: env.PATH, HOME: home, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR, LANG: 'C'}, children, () => fs.existsSync(socket));
    }
    await startChild('the server', SERVER_COMMAND, env, children, () => accepts(port)); // limit: another listener on this port would also pass; its answers are not told apart
    const token = fs.readFileSync(path.join(env.MESH_CONF_DIR!, 'token'), 'utf8').trim();
    const mesh: Mesh = {base: `http://127.0.0.1:${port}`, home, token, cookie: `mesh_auth=${ownerCookie(token)}`,
      sessionToken: undefined, plainSessionToken: undefined, hostPresent: fake !== undefined, stop};
    if (fake !== undefined) {
      mesh.sessionToken = await launchSession(mesh, SESSION_NAME, {preset: 'claude'});
      // The same script started under its own name (node), so the host does not take it for an agent.
      const script = path.join(fake.bin, 'fake-claude.js');
      mesh.plainSessionToken = await launchSession(mesh, 'plain', {preset: 'custom', command: `'${process.execPath}' '${script}'`});
    }
    return mesh;
  } catch (error) {
    await stop();
    throw error;
  }
}

// The owner cookie at generation 0: HMAC-SHA256(master token, "session-mesh"). The one contract the
// harness takes from the implementation, besides the route table and the token file.
function ownerCookie(token: string): string {
  return createHmac('sha256', token).update('session-mesh').digest('hex');
}

// A fake Claude script (see claude-wake-lib.ts): it writes the MESH_SESSION_TOKEN it was given to ./token in its
// working directory. That token is the only credential of this kind a client can obtain, exactly as an agent
// in the session does.
async function launchSession(mesh: Mesh, name: string, launch: Record<string, string>): Promise<string> {
  const dir = path.join(mesh.home, name);
  fs.mkdirSync(dir);
  const response = await fetch(`${mesh.base}/api/new`, {method: 'POST', redirect: 'manual',
    headers: {Authorization: `Bearer ${mesh.token}`, Origin: mesh.base, 'Content-Type': 'application/json'},
    body: JSON.stringify({...launch, cwd: dir, name})});
  if (response.status !== 200) throw new Error(`could not create the session (${response.status}): ${await response.text()}`);
  await waitFor(`the token file of session ${name}`, 20000, () => fs.existsSync(path.join(dir, 'token')));
  return fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
}

// ---------------------------------------------------------------- requests

export type Credential = 'none' | 'cookie' | 'bearer' | 'session';
export type Observed = {status: number; location: string | null};
export type Answer = Observed & {body: string; headers: Headers};

function credentialHeaders(mesh: Mesh, route: Route, credential: Credential): Record<string, string> {
  switch (credential) {
    case 'none': return {};
    case 'cookie': return {Cookie: mesh.cookie};
    case 'bearer': return {Authorization: `Bearer ${mesh.token}`};
    case 'session': {
      const token = PLAIN_SESSION_ROUTES.has(routeKey(route)) ? mesh.plainSessionToken : mesh.sessionToken;
      if (token === undefined) throw new Error('no session token: the PTY host is not available');
      return {Authorization: `MeshSession ${token}`};
    }
  }
}

// Routes whose side effect is not bounded by a malformed JSON body (see the hand-off).
const EMPTY_BODY_ROUTES = new Set(['/api/upload']);

/** One request with a safe body: a JSON array (every handler that reads an object answers 400) or, for an
 *  upload, nothing at all. Redirects are not followed. The body of an error answer is always read. */
export async function observe(mesh: Mesh, route: Route, credential: Credential,
                              extraHeaders: Record<string, string> = {}, readBody = false): Promise<Answer> {
  const hasBody = route.method !== 'GET' && route.method !== 'HEAD';
  const headers: Record<string, string> = {...credentialHeaders(mesh, route, credential), ...extraHeaders};
  if (hasBody) headers.Origin ??= mesh.base;
  if (hasBody && !EMPTY_BODY_ROUTES.has(route.canonical)) headers['Content-Type'] ??= 'application/json';
  const init: RequestInit = {method: route.method, redirect: 'manual', headers, signal: AbortSignal.timeout(10000)};
  if (hasBody && !EMPTY_BODY_ROUTES.has(route.canonical)) init.body = '[]';
  const response = await fetch(`${mesh.base}${route.path}`, init);
  let body = '';
  if (readBody || response.status >= 400) body = await response.text();
  else await response.body?.cancel();
  const seen = {status: response.status, location: response.headers.get('location')};
  record(route, `${credential}${Object.keys(extraHeaders).length > 0 ? '+headers' : ''}`, seen);
  return {...seen, body, headers: response.headers};
}

// HARNESS_OBSERVATIONS=<file> appends one JSON line per observed request (route, credential, status):
// the raw material of the route -> class -> status table in a hand-off.
function record(route: Route, credential: string, seen: Observed): void {
  const file = process.env.HARNESS_OBSERVATIONS;
  if (file) fs.appendFileSync(file, `${JSON.stringify({route: `${route.method} ${route.canonical}`, klass: route.klass, credential, ...seen})}\n`);
}

const isLoginRedirect = (seen: Observed): boolean => seen.status === 302 && seen.location === FRAMEWORK_ANSWERS.loginRedirect;
/** What the auth boundary looks like to a client that is refused: 401, or a redirect to /login. */
const isRefused = (seen: Observed): boolean => seen.status === 401 || isLoginRedirect(seen);

export const shown = (seen: Observed): string => `${seen.status}${seen.location === null ? '' : ` -> ${seen.location}`}`;
export const where = (route: Route, credential: string): string => `${label(route)} with ${credential}`;

// ---------------------------------------------------------------- verdicts (see the header for the two kinds)

export type Expectation = 'accepted' | 'refused';

/** The label of every failure. A credential that should have been refused is a boundary change whatever came
 *  back. One that should have been accepted is a boundary change when the boundary stopped it, and a business
 *  change when a handler answered, a 403 with the handler's own text included. */
export function changeLabel(expectation: Expectation, seen: Answer): {kind: string; hint: string} {
  const stopped = isRefused(seen) || (seen.status === 403 && seen.body.trim() === FRAMEWORK_ANSWERS.bare[403]);
  const hint = seen.status === 404 || seen.status === 405 ? ' (is the route still served?)' : '';
  return {kind: expectation === 'refused' || stopped ? 'AUTH-BOUNDARY' : 'BUSINESS-STATUS', hint};
}

/** Fail with the labelled message: "<kind> change: <what>, got <answer><detail><hint>". */
export function failChange(expectation: Expectation, what: string, seen: Answer, detail = ''): never {
  const {kind, hint} = changeLabel(expectation, seen);
  assert.fail(`${kind} change: ${what}, got ${shown(seen)}${detail}${hint}`);
}

/** The credential crosses the boundary and the handler gives its golden answer (`cell`: by default the route's). */
export async function expectAccepted(mesh: Mesh, route: Route, credential: Credential,
                                      cell: Cell = acceptedCell(route, mesh.hostPresent)): Promise<void> {
  const seen = await observe(mesh, route, credential, {}, cell.body !== null);
  const handlerBody = cell.body === null || seen.body.includes(cell.body);
  if (seen.status === cell.status && seen.location === null && handlerBody) return;
  const expected = `${cell.status}${cell.body === null ? '' : ` with ${JSON.stringify(cell.body)} in the body`}`;
  failChange('accepted', `${where(route, credential)} should be accepted with ${expected}`, seen,
    handlerBody ? '' : ` without that body (${JSON.stringify(seen.body.slice(0, 80))})`);
}

/** The credential (plus any extra headers) is refused at the boundary, in the form its route gets. */
export async function expectRefused(mesh: Mesh, route: Route, credential: Credential,
                                     extraHeaders: Record<string, string> = {}, why = ''): Promise<void> {
  const expected = refusal(route, credential);
  const seen = await observe(mesh, route, credential, extraHeaders);
  if (seen.status === expected.status && seen.location === expected.location) return;
  failChange('refused', `${where(route, credential)}${why} should be refused with ${shown(expected)}, but was `
    + (isRefused(seen) ? 'refused in another form' : 'not refused'), seen);
}
