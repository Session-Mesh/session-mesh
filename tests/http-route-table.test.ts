// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Black-box check of the route table (tests/test_route_auth_table.py, read as text) against a running
// server: the table itself is well formed, the golden tables of http-harness.ts cover it, and the boundary
// every client meets without a credential (or with a wrong Origin) is the one the table claims.
// Failures name an AUTH-BOUNDARY or a BUSINESS-STATUS change (changeLabel in http-harness.ts, checked below).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {after, before, describe, test} from 'node:test';
import {
  CLASSES, CLASS_NAMES, FRAMEWORK_ANSWERS, ROUTE_TABLE_FILE, acceptedCell, changeLabel, expectAccepted, expectRefused, expectedStatusTable,
  failChange, hostAvailable, label, observe, parseRouteTable, readRouteTable, routeKey, routesOf,
  sessionSkipReason, startMesh, where, type Answer, type Cell, type Credential, type Mesh, type Route,
} from './http-harness.ts';

const routes = readRouteTable();
const hostPresent = hostAvailable();
let mesh: Mesh;

before(async () => { mesh = await startMesh({session: hostPresent}); });
after(async () => { await mesh?.stop(); });

// Every 403 or 404 cell of the golden tables (http-harness.ts), and why the handler gives it once the credential
// has crossed the boundary. The middleware's own 403 (a foreign Origin) is bare and never answers a GET.
const PLAIN = '403: the session cell uses a plain (non-agent) session\'s token, which the handler refuses by name';
const HANDLER_ANSWERS: Record<string, string> = {
  'GET /view/{tail}': '403: an unsigned capability URL (a public GET; an unserved route answers 404)',
  'POST /api/config/launch': '403: no configuration elevation, named in the body',
  'GET /api/agent-mail/@self/pi-wakes': PLAIN,
  'POST /api/agent-mail/@self/pi-wake-ack': PLAIN,
  'GET /api/portfolio/diff/{selector}': '404: no diff selector is known (see BLIND_CELLS)',
  'GET /api/update/notes': '404: no release is announced with notes, named in the body',
};

// Accepted cells whose own answer cannot tell the handler from a path the server does not serve. Each of them is
// proved registered by a wrong-method probe ('a blind cell is still a registered route' below), so a removed
// route is detected; the text says what stays blind.
const BLIND_CELLS: Record<string, string> = {
  'GET /api/portfolio/diff/{selector}': 'the GET with the cookie or the Bearer token: the handler answers the bare '
    + '"404: Not Found" to a query, to a PTY host error and to every selector it did not issue, and it issues one '
    + 'only when the optional worktree observer is installed inside the server checkout (_opam/bin). That answer '
    + 'is byte for byte the router\'s one for a path it does not serve, whatever the credential, the selector or '
    + 'the body. Detected all the same: a removed route (the probe gets 404 instead of 405) and a refusal (401, '
    + '403). Still blind: a handler that answers 404 to a selector it should know.',
};

// What the framework answers by itself, with no handler text: the middleware's refusals (401, 403), a path the
// router does not serve (404), a method it does not serve there (405), and a handler's bare refusal of a
// request (400). A golden body text found in one of them would pass without any handler having written it.
const BARE_ANSWERS = Object.values(FRAMEWORK_ANSWERS.bare);

// The @self routes that a {name} route of the same method also answers (found by removing each route in turn).
const SHADOWED_SELF = ['GET /api/board/@self/revision', 'GET /api/board/@self/revision/diff', 'PUT /api/board/@self',
  'POST /api/board/@self/revision/restore', 'GET /api/demo-scene/@self/selected',
  'GET /api/demo-scene/@self/selected/revisions', 'POST /api/demo-scene/@self/selected/restore'];

describe('the route table, parsed from tests/test_route_auth_table.py', () => {
  test('every entry line of EXPECTED is parsed, once', () => {
    const source = fs.readFileSync(ROUTE_TABLE_FILE, 'utf8');
    const entryLines = source.split('\n').filter(line => /^    \("[A-Z]+", "/.test(line));
    assert.equal(routes.length, entryLines.length);
    assert.ok(routes.length > 90, `only ${routes.length} routes parsed`);
  });

  test('every class is used and each route has a concrete path', () => {
    for (const klass of CLASSES) assert.ok(routesOf(routes, klass).length > 0, `no route of class ${klass}`);
    for (const route of routes) assert.doesNotMatch(route.path, /[{}]/, label(route));
  });

  test('the Python file declares the class constants the parser assumes, in the same order', () => {
    const declared = /^([A-Z_, ]+) = \(\s*([^)]*)\)$/m.exec(fs.readFileSync(ROUTE_TABLE_FILE, 'utf8'));
    assert.equal(declared?.[1], CLASS_NAMES.join(', '));
    assert.deepEqual(JSON.parse(`[${declared?.[2]}]`), [...CLASSES]);
  });

  test('the parser refuses a malformed or duplicated table', () => {
    const table = (body: string) => `EXPECTED = {\n${body}\n}\n`;
    assert.equal(parseRouteTable(table('    ("GET", "/a"): PUBLIC,\n    ("POST", "/b/{n}"): SESSION_ONLY,')).length, 2);
    assert.throws(() => parseRouteTable(table('    ("GET", "/a"): PUBLIC,\n    ("GET", "/a"): COOKIE,')), /duplicate/);
    assert.throws(() => parseRouteTable(table('    ("GET", "/a"): NOPE,')), /unknown class/);
    assert.throws(() => parseRouteTable(table('    GET /a PUBLIC,')), /unparsed/);
  });
});

describe('the golden tables of http-harness.ts', () => {
  test('the expected status table covers exactly the routes (POST /login aside), including disabled dictation', () => {
    const table = expectedStatusTable('host');
    const keys = routes.map(routeKey).filter(key => key !== 'POST /login').sort();
    assert.deepEqual([...table.keys()].sort(), keys);
    const disabled = new Set(['POST /api/transcribe', 'GET /api/transcribe/request/{request_id}',
      'GET /api/transcribe/{job_id}', 'POST /api/transcribe/{job_id}/cancel', 'POST /api/transcribe/{job_id}/settle']);
    for (const [key, cell] of table) assert.ok([200, 400, 403, 404].includes(cell.status)
      || (disabled.has(key) && cell.status === 503 && cell.body === 'Dictation is disabled.'),
    `${key}: ${cell.status}`);
  });

  test('the no-host table only overrides routes of the table, with 503 (the PTY host is not responding)', () => {
    const keys = new Set(routes.map(routeKey));
    for (const [key, cell] of expectedStatusTable('no-host')) {
      assert.ok(keys.has(key), key);
      assert.equal(cell.status, 503, key);
    }
  });
});

describe('a golden cell proves that its handler answered', () => {
  // A 403 or 404 cell proves the handler ran only if a missing route (404) and a middleware refusal (401, the
  // redirect, a bare 403) cannot produce it: its body names the handler's refusal, or it is a public GET's 403
  // (the middleware never answers 403 to a GET, and a missing route answers 404). Anything else is blind.
  const cells = (): [string, Cell][] => [...expectedStatusTable('host'), ...expectedStatusTable('no-host')];
  const odd = (): [string, Cell][] => cells().filter(([, cell]) => cell.status === 403 || cell.status === 404);
  const provable = (key: string, cell: Cell): boolean => cell.body !== null
    || (cell.status === 403 && key.startsWith('GET ') && routes.find(route => routeKey(route) === key)?.klass === 'public');

  test('every 403 and 404 cell is a documented handler answer, and every documented answer is in a table', () => {
    const keys = [...new Set(odd().map(([key]) => key))].sort();
    assert.deepEqual(keys, Object.keys(HANDLER_ANSWERS).sort());
    for (const [key, cell] of odd()) assert.ok(HANDLER_ANSWERS[key]!.startsWith(`${cell.status}:`), key);
  });

  test('BLIND_CELLS lists exactly the 403 and 404 cells that cannot tell the handler from a missing route', () => {
    const blind = [...new Set(odd().filter(([key, cell]) => !provable(key, cell)).map(([key]) => key))].sort();
    assert.deepEqual(blind, Object.keys(BLIND_CELLS).sort());
  });

  test('no golden body text is part of an answer the framework gives by itself', () => {
    for (const [key, cell] of cells()) {
      const bare = BARE_ANSWERS.find(answer => answer.toLowerCase().includes((cell.body ?? '\0').toLowerCase()));
      assert.equal(bare, undefined, `${key}: ${JSON.stringify(cell.body)} is also in the bare answer "${bare}"`);
    }
  });

  // /api/board/@self/revision is also a path of /api/board/{name}/revision: were the first route removed, the
  // second would answer in its place, with its own bare 400 to the name "@self". So the cell of such a route
  // is never a bare one: it is a 200, or it carries a text of its handler.
  test('a route whose path a second route also matches does not have a bare cell', () => {
    const matcher = (route: Route): RegExp => new RegExp(`^${route.canonical.replace(/\{[a-z_]+\}/g, '[^/]+')}$`);
    const shadowed: string[] = [];
    for (const route of routes.filter(entry => entry.canonical !== '/login' || entry.method !== 'POST')) {
      const second = routes.find(other => other !== route && other.method === route.method
        && matcher(other).test(route.path.replace(/\?.*$/, '')));
      if (second !== undefined) shadowed.push(routeKey(route));
      const cell = acceptedCell(route, true);
      assert.ok(second === undefined || cell.status === 200 || cell.body !== null,
        `${routeKey(route)} is also a path of ${second?.canonical}: its bare ${cell.status} cell proves nothing`);
    }
    // Positive control: the matcher must still find the seven @self routes the removal sweep showed to be shadowed.
    const missed = SHADOWED_SELF.filter(key => !shadowed.includes(key));
    assert.deepEqual(missed, [], 'the shared-path matcher no longer finds these known shadowed routes');
  });
});

// One function labels every failure (changeLabel): its answer for each family of status, under both verdicts.
describe('the failure label', () => {
  const answer = (status: number, body = '', location: string | null = null): Answer =>
    ({status, location, body, headers: new Headers()});
  const SERVED = ' (is the route still served?)';
  const FAMILIES: [string, Answer, string, string][] = [
    ['2xx', answer(200), 'BUSINESS-STATUS', 'AUTH-BOUNDARY'],
    ['3xx to /login', answer(302, '', '/login'), 'AUTH-BOUNDARY', 'AUTH-BOUNDARY'],
    ['3xx elsewhere', answer(302, '', '/login?bad=1'), 'BUSINESS-STATUS', 'AUTH-BOUNDARY'],
    ['400', answer(400, '400: Bad Request'), 'BUSINESS-STATUS', 'AUTH-BOUNDARY'],
    ['401', answer(401, '401: Unauthorized'), 'AUTH-BOUNDARY', 'AUTH-BOUNDARY'],
    ['403, bare', answer(403, '403: Forbidden'), 'AUTH-BOUNDARY', 'AUTH-BOUNDARY'],
    ['403, a handler text', answer(403, 'Answer buttons disabled: set MESH_ANSWER_BUTTONS=1'), 'BUSINESS-STATUS', 'AUTH-BOUNDARY'],
    ['403, a handler JSON', answer(403, '{"error": "elevation-required"}'), 'BUSINESS-STATUS', 'AUTH-BOUNDARY'],
    ['404', answer(404, '404: Not Found'), `BUSINESS-STATUS${SERVED}`, `AUTH-BOUNDARY${SERVED}`],
    ['405', answer(405, '405: Method Not Allowed'), `BUSINESS-STATUS${SERVED}`, `AUTH-BOUNDARY${SERVED}`],
    ['5xx', answer(500, '500 Internal Server Error'), 'BUSINESS-STATUS', 'AUTH-BOUNDARY'],
    ['503', answer(503, 'ptyhost not responding'), 'BUSINESS-STATUS', 'AUTH-BOUNDARY'],
  ];
  for (const [family, seen, accepted, refused] of FAMILIES) {
    test(`${family}: ${accepted} when it should be accepted, ${refused} when it should be refused`, () => {
      const shownAs = (change: {kind: string; hint: string}): string => `${change.kind}${change.hint}`;
      assert.equal(shownAs(changeLabel('accepted', seen)), accepted);
      assert.equal(shownAs(changeLabel('refused', seen)), refused);
    });
  }

  test('a failure message is "<kind> change: <what>, got <answer><detail><hint>"', () => {
    assert.throws(() => failChange('accepted', 'GET /x with cookie should be accepted with 200', answer(404), ' (detail)'),
      {message: 'BUSINESS-STATUS change: GET /x with cookie should be accepted with 200, got 404 (detail)'
        + ' (is the route still served?)'});
    assert.throws(() => failChange('refused', 'GET /x with bearer should be refused with 401', answer(302, '', '/login')),
      {message: 'AUTH-BOUNDARY change: GET /x with bearer should be refused with 401, got 302 -> /login'});
  });
});

// A blind cell answers like a path the router does not serve. The router tells the two apart on another method:
// a path it serves refuses a method it does not have with 405 and lists the ones it has (Allow); a path it does
// not serve answers 404. The cookie passes the boundary first, and no handler runs.
describe('a blind cell is still a registered route', () => {
  for (const key of Object.keys(BLIND_CELLS)) {
    const route = routes.find(entry => routeKey(entry) === key)!;
    const registered = routes.filter(entry => entry.canonical === route.canonical).map(entry => entry.method);
    const allow = FRAMEWORK_ANSWERS.allow(registered);
    for (const method of ['POST', 'PUT'].filter(entry => !registered.includes(entry))) {
      test(`${method} ${route.canonical} with the cookie: 405, Allow: ${allow}`, async () => {
        const seen = await observe(mesh, {...route, method}, 'cookie');
        if (seen.status === 405 && seen.headers.get('allow') === allow) return;
        failChange('accepted', `${where({...route, method}, 'cookie')} should be refused as a method with 405 and `
          + `Allow: ${allow}`, seen, ` with Allow: ${seen.headers.get('allow')}`);
      });
    }
  }
});

// What a client with no credential meets: 401 on the API and the terminal socket, a redirect to /login on pages.
describe('without a credential', () => {
  for (const route of routesOf(routes, 'cookie', 'cookie-only', 'session', 'session-only')) {
    test(label(route), async () => {
      await expectRefused(mesh, route, 'none');
    });
  }

  for (const route of routesOf(routes, 'cookie', 'cookie-only', 'session', 'session-only').filter(entry => entry.method === 'GET')) {
    test(`HEAD ${route.canonical} follows GET`, async () => {
      await expectRefused(mesh, {...route, method: 'HEAD'}, 'none');
    });
  }

  for (const route of routesOf(routes, 'public').filter(entry => entry.method === 'GET')) {
    test(`public: ${route.method} ${route.canonical} answers ${acceptedCell(route, hostPresent).status}, not gated`, async () => {
      await expectAccepted(mesh, route, 'none');
    });
  }

  test('public: POST /login with a wrong token goes back to /login, not 401', async () => {
    const response = await fetch(`${mesh.base}/login`, {method: 'POST', redirect: 'manual',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: 'token=wrong'});
    const seen: Answer = {status: response.status, location: response.headers.get('location'),
      body: await response.text(), headers: response.headers};
    if (seen.status === 302 && seen.location === `${FRAMEWORK_ANSWERS.loginRedirect}?bad=1`) return;
    failChange('accepted', 'POST /login [public] with a wrong token should go back to the form (302 -> /login?bad=1)', seen);
  });
});

// A state-changing request is refused when its Origin is not the server's own, after authentication and
// before the handler runs (so this never has a side effect). The refusal is the middleware's bare 403, which
// tells it from a cell whose golden answer is itself a 403 with the handler's text.
const credentialOf = (route: Route): Credential => route.klass === 'session' || route.klass === 'session-only' ? 'session' : 'cookie';

describe('a foreign Origin', () => {
  const skip = sessionSkipReason();
  for (const route of routesOf(routes, 'cookie', 'cookie-only', 'session', 'session-only').filter(entry => entry.method !== 'GET')) {
    test(label(route), {skip: credentialOf(route) === 'session' && skip}, async () => {
      const credential = credentialOf(route);
      const seen = await observe(mesh, route, credential, {Origin: 'http://evil.example'});
      if (seen.status === 403 && seen.body === FRAMEWORK_ANSWERS.bare[403]) return;
      failChange('refused', `${where(route, credential)} from a foreign Origin should be refused with the `
        + 'middleware\'s bare 403', seen, seen.status === 403 ? ` with the body ${JSON.stringify(seen.body.slice(0, 80))}` : '');
    });
  }
});
