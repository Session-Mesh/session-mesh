// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Black-box authentication matrix: for every route of the table (tests/test_route_auth_table.py), real HTTP
// requests with each credential a client can hold (none, owner cookie, master Bearer token, session token)
// and the outcome its class requires. Both sides are exact: a refused credential gets 401 (or the redirect to
// /login for a page without any credential); an accepted one gets the exact answer recorded for that route in
// the golden tables of http-harness.ts (acceptedCell), so a 404, 405, 5xx or a middleware 403 never passes for
// "accepted". Failures name an AUTH-BOUNDARY or a BUSINESS-STATUS change (changeLabel in http-harness.ts).
// Requests carry a body that no handler acts on (see observe() in http-harness.ts).
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {after, before, describe, test} from 'node:test';
import {
  acceptedCell, expectAccepted, expectRefused, failChange, hostAvailable, label, observe, readRouteTable, routesOf,
  sessionSkipReason, startMesh, type Credential, type Mesh, type Route, type RouteClass,
} from './http-harness.ts';

const routes = readRouteTable();
const skipSession = sessionSkipReason();
const hostPresent = hostAvailable();
let mesh: Mesh;

before(async () => { mesh = await startMesh({session: hostPresent}); });
after(async () => { await mesh?.stop(); });

// Credentials each class accepts (the others are refused).
const ACCEPTED: Record<Exclude<RouteClass, 'public'>, Credential[]> = {
  cookie: ['cookie', 'bearer'],
  'cookie-only': ['cookie'],
  session: ['cookie', 'bearer', 'session'],
  'session-only': ['session'],
};
const ALL: Credential[] = ['none', 'cookie', 'bearer', 'session'];

// POST /api/logout-all raises the cookie generation: every cookie is stale afterwards. It runs last.
const LAST = (route: Route): boolean => route.canonical === '/api/logout-all';

for (const klass of ['cookie', 'cookie-only', 'session', 'session-only'] as const) {
  describe(`class ${klass}`, () => {
    for (const route of routesOf(routes, klass).filter(entry => !LAST(entry))) {
      for (const credential of ALL) {
        const accepted = ACCEPTED[klass].includes(credential);
        const outcome = accepted ? `is accepted with ${acceptedCell(route, hostPresent).status}` : 'is refused';
        test(`${label(route)} with ${credential}: ${outcome}`, {skip: credential === 'session' && skipSession}, async () => {
          await (accepted ? expectAccepted(mesh, route, credential) : expectRefused(mesh, route, credential));
        });
      }
    }
  });
}

describe('a credential that is almost right', () => {
  const protectedRoutes = routesOf(routes, 'cookie', 'cookie-only', 'session', 'session-only').filter(entry => !LAST(entry));

  for (const route of protectedRoutes) {
    test(`${label(route)}: a wrong cookie and a wrong Bearer token are refused`, async () => {
      // Same length and alphabet as the right credential, last character changed: rejected on the comparison.
      const wrong: Record<string, string>[] = [{Cookie: nearMiss(mesh.cookie)},
        {Authorization: `Bearer ${nearMiss(mesh.token)}`}, {Cookie: 'mesh_auth=0'.padEnd(75, '0')},
        {Authorization: 'Bearer wrong'}];
      for (const headers of wrong) await expectRefused(mesh, route, 'none', headers, ` and ${JSON.stringify(headers)}`);
    });
  }

  for (const route of routesOf(routes, 'session', 'session-only')) {
    test(`${label(route)}: forged session tokens are 401`, {skip: skipSession}, async () => {
      const [, name, nonce, mac] = mesh.sessionToken!.split('.');
      const badMac = `ms1.${name}.${nonce}.${'0'.repeat(64)}`;
      const unknownSession = signedToken(mesh.token, 'nosuchsession', '0'.repeat(32));
      const otherIncarnation = signedToken(mesh.token, name!, 'f'.repeat(32));
      assert.notEqual(mac, '0'.repeat(64));
      for (const token of [badMac, unknownSession, otherIncarnation, 'ms1.x', '']) {
        await expectRefused(mesh, route, 'none', {Authorization: `MeshSession ${token}`}, ` and token ${token.slice(0, 20)}`);
      }
    });
  }

  test('a session token is also refused when the owner cookie rides along (it is judged alone)', {skip: skipSession}, async () => {
    const cookieRoute = routesOf(routes, 'cookie').find(entry => entry.method === 'GET')!;
    await expectRefused(mesh, cookieRoute, 'session', {Cookie: mesh.cookie}, ' and the owner cookie');
  });

  // Cookie-only: "every Authorization header is 401", also next to the owner cookie that alone is accepted.
  for (const route of routesOf(routes, 'cookie-only')) {
    test(`${label(route)}: the owner cookie plus a Bearer header is 401`, async () => {
      await expectRefused(mesh, route, 'bearer', {Cookie: mesh.cookie}, ' and the owner cookie');
    });
    test(`${label(route)}: the owner cookie plus a session token is 401`, {skip: skipSession}, async () => {
      await expectRefused(mesh, route, 'session', {Cookie: mesh.cookie}, ' and the owner cookie');
    });
  }
});

// "HEAD is derived from GET": with a credential its class accepts, HEAD gets the status of the GET (no body).
// The one GET registered without a HEAD answers 405 to it.
const NO_HEAD = new Set(['/api/agent-mail/@self/pi-wakes']);
const acceptedBy = (route: Route): Credential =>
  route.klass === 'public' ? 'none' : route.klass === 'session-only' ? 'session' : 'cookie';

describe('HEAD follows GET with an accepted credential', () => {
  for (const route of routes.filter(entry => entry.method === 'GET')) {
    const credential = acceptedBy(route);
    const status = NO_HEAD.has(route.canonical) ? 405 : acceptedCell(route, hostPresent).status;
    test(`HEAD ${route.canonical} [${route.klass}] with ${credential}: ${status}`,
      {skip: credential === 'session' && skipSession}, async () => {
        await expectAccepted(mesh, {...route, method: 'HEAD'}, credential, {status, body: null});
      });
  }
});

// The credential with its last character changed (still well-formed: same length, same alphabet).
const nearMiss = (value: string): string => value.slice(0, -1) + (value.endsWith('0') ? '1' : '0');

// A session token minted with the documented derivation: HMAC(HMAC(master, "session-mesh/session-token/v1"),
// "ms1\0name\0nonce"). Used only to make well-signed tokens that no live session backs.
function signedToken(master: string, name: string, nonce: string): string {
  const key = createHmac('sha256', master).update('session-mesh/session-token/v1').digest();
  const mac = createHmac('sha256', key).update(`ms1\0${name}\0${nonce}`).digest('hex');
  return `ms1.${name}.${nonce}.${mac}`;
}

describe('class public', () => {
  for (const route of routesOf(routes, 'public').filter(entry => entry.method === 'GET')) {
    for (const credential of ALL) {
      test(`${label(route)} with ${credential}: answers ${acceptedCell(route, hostPresent).status}, not gated`,
        {skip: credential === 'session' && skipSession}, async () => {
          await expectAccepted(mesh, route, credential);
        });
    }
  }

  // The two vendored-library routes are probed with real files (see concretePath): check they are the files.
  for (const [vendored, type] of [['/viewlib/marked.min.js', /javascript/], ['/viewlib/monaco/LICENSE', /./]] as const) {
    test(`${vendored} is served without a credential`, async () => {
      const seen = await observe(mesh, asset(vendored), 'none', {}, true);
      const sent = seen.headers.get('content-type') ?? '';
      if (seen.status === 200 && type.test(sent) && seen.body.length > 100) return;
      failChange('accepted', `${vendored} without a credential should be the vendored file (200, a content type `
        + `matching ${type}, over 100 bytes)`, seen, ` as ${JSON.stringify(sent)} with ${seen.body.length} bytes`);
    });
  }
});

// A file that is not an entry of the route table, as a route of its own.
const asset = (path: string, klass: RouteClass = 'public'): Route => ({method: 'GET', canonical: path, klass, path});

describe('/static is private except the login assets and the three icons', () => {
  for (const path of ['/static/login.js', '/static/login.css', '/static/icons/icon-192.png',
    '/static/icons/icon-512.png', '/static/icons/maskable-512.png']) {
    test(`${path} is public`, async () => {
      await expectAccepted(mesh, asset(path), 'none', {status: 200, body: null});
    });
  }
  test('/static/app.js is not, and with the cookie it is served', async () => {
    await expectRefused(mesh, asset('/static/app.js', 'cookie'), 'none');
    await expectAccepted(mesh, asset('/static/app.js', 'cookie'), 'cookie', {status: 200, body: null});
  });
  // The public assets are exact paths, not a prefix: this path is not one of them, so it gets the private
  // /static answer, the redirect to /login (exactly that answer, not merely "refused or 404").
  test('a traversal into the private assets through the public prefix is not public', async () => {
    await expectRefused(mesh, asset('/static/icons/..%2fapp.js'), 'none');
  });
});

// Last, because it invalidates every cookie: the cookie and the Bearer token both cross the boundary, and the
// generation bump then revokes the cookie while the master token and the session token keep working.
describe('log out everywhere', () => {
  const route = routes.find(LAST)!;
  test('the route exists and is class cookie', () => assert.equal(route?.klass, 'cookie'));

  const sessions = routes.find(entry => entry.canonical === '/api/sessions')!;
  const board = routes.find(entry => entry.canonical === '/api/board/@self' && entry.method === 'GET')!;

  test('no credential is refused', async () => {
    await expectRefused(mesh, route, 'none');
  });

  test('a session token is refused', {skip: skipSession}, async () => {
    await expectRefused(mesh, route, 'session');
  });

  test('the cookie is accepted once and is stale afterwards', async () => {
    await expectAccepted(mesh, sessions, 'cookie');
    await expectAccepted(mesh, route, 'cookie');
    await expectRefused(mesh, sessions, 'cookie', {}, ' after log out everywhere');
  });

  test('the master token is accepted before and after', async () => {
    await expectAccepted(mesh, sessions, 'bearer');
    await expectAccepted(mesh, route, 'bearer');
    await expectAccepted(mesh, sessions, 'bearer');
  });

  test('the session token still works', {skip: skipSession}, async () => {
    await expectAccepted(mesh, board, 'session');
  });
});
