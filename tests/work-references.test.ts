// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The known ids behind the terminal references (static/work-references.ts): the parsing of `work-read ids`, where each
// reference leads in the Projects view, and the reads of the cache against a fake fetch, a fake clock and the page's
// read slots. The links on the page are in tests/terminal-references-browser.test.ts. All data here is fictional.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readSlots } from '../static/work-api.ts';
import { createReferences, parseIds, REFERENCES_INTERVAL_MS } from '../static/work-references.ts';

const DOC = {
  schema: 1, command: 'ids', truncated: false,
  tasks: [{ id: 'T-1a2b', title: 'Ship the first delivery' }, { id: 'T-3c4d', title: '<img src=x onerror=alert(1)>' }],
  projects: [{ id: 'P-5e6f', title: 'Delivery rollout' }],
  questions: [
    { id: 'N-0000abcd', title: 'Which slot?', about: 'T-3c4d', project: 'P-5e6f' },
    { id: 'N-0000beef', title: 'December?', about: 'P-5e6f', project: 'P-5e6f' },
    { id: 'N-00000a02', title: 'Free question' },
  ],
};

describe('parsing ids', () => {
  test('tasks, projects and questions by id, titles kept as text, each with where it leads', () => {
    const known = parseIds(DOC);
    assert.ok(known);
    assert.deepEqual(known.get('T-1a2b'), { id: 'T-1a2b', kind: 'task', title: 'Ship the first delivery',
      target: { kind: 'task', id: 'T-1a2b', tab: 'board' } });
    assert.equal(known.get('T-3c4d')?.title, '<img src=x onerror=alert(1)>', 'untrusted text, never markup: shown as text');
    assert.deepEqual(known.get('P-5e6f')?.target, { kind: 'project', id: 'P-5e6f', tab: 'reprise' });
    assert.deepEqual(known.get('N-0000abcd')?.target, { kind: 'task', id: 'T-3c4d' }, 'about a task: its sheet, Questions tab');
    assert.deepEqual(known.get('N-0000beef')?.target, { kind: 'project', id: 'P-5e6f' }, 'about a project: its Questions tab');
    assert.deepEqual(known.get('N-00000a02')?.target, { kind: 'entry' }, 'about nothing: the entry screen');
    assert.equal(known.size, 6);
  });

  test('a question about a task in no project leads to the entry screen, as the session marker does', () => {
    const known = parseIds({
      tasks: [], projects: [],
      questions: [
        { id: 'N-0000a001', title: 'No project', about: 'T-3c4d' },
        { id: 'N-0000a002', title: 'Malformed project', about: 'T-3c4d', project: 'P-../x' },
        { id: 'N-0000a003', title: 'In a project', about: 'T-3c4d', project: 'P-5e6f' },
      ],
    });
    assert.ok(known);
    assert.deepEqual(known.get('N-0000a001')?.target, { kind: 'entry' }, 'the task has no sheet in the Projects view');
    assert.deepEqual(known.get('N-0000a002')?.target, { kind: 'entry' });
    assert.deepEqual(known.get('N-0000a003')?.target, { kind: 'task', id: 'T-3c4d' });
  });

  test('a cut document (truncated) still gives the ids it lists', () => {
    const known = parseIds({ ...DOC, truncated: true, tasks_omitted: 3000, questions: [] });
    assert.ok(known);
    assert.equal(known.get('T-1a2b')?.title, 'Ship the first delivery');
    assert.equal(known.size, 3);
  });

  test('not a document: null; malformed ids, wrong kinds, control characters and long titles are dealt with', () => {
    assert.equal(parseIds(null), null);
    assert.equal(parseIds({ tasks: 'x' }), null);
    assert.equal(parseIds([]), null);
    const known = parseIds({
      tasks: [null, 7, { id: 'T-1A2B', title: 'upper' }, { id: 'P-1a2b', title: 'a project in tasks' }, { id: 'T-zz', title: 'x' },
        { id: 'T-abcd', title: `a\u0000b\u202ec${'x'.repeat(500)}` }, { id: 'T-abcd', title: 'second' }, { id: 'T-beef' },
        { id: 'T-cafe', title: 'o\u034fk\ufe0f\u{e0041}\u{e0100}' }],
      projects: [{ id: 'T-5e6f', title: 'a task in projects' }],
      questions: [{ id: 'N-0000abcd', title: 'q', about: 'T-../../x' }],
    });
    assert.ok(known);
    assert.deepEqual([...known.keys()], ['T-abcd', 'T-beef', 'T-cafe', 'N-0000abcd']);
    assert.equal(known.get('T-cafe')?.title, 'ok', 'grapheme joiner, variation selectors and tag characters removed');
    const title = known.get('T-abcd')!.title;
    assert.ok(!/[\u0000-\u001f\u202e]/u.test(title) && title.length <= 120, title);
    assert.equal(known.get('T-beef')?.title, '', 'no title: none shown');
    assert.deepEqual(known.get('N-0000abcd')?.target, { kind: 'entry' }, 'a malformed about leads nowhere specific');
  });
});

type Reply = { status: number; body: unknown };
const OK: Reply = { status: 200, body: DOC };
const error = (status: number, code: string): Reply => ({ status, body: { error: { code, message: code } } });

/** A cache over a fake fetch answering from `replies` (the last one repeats) and a clock the test moves. */
function rig(replies: Reply[], visible = () => true, slots = readSlots(2)) {
  let now = 5_000_000;
  const ops: string[] = [];
  const request = async (_url: string, init: RequestInit): Promise<Response> => {
    ops.push(String(JSON.parse(String(init.body)).op));
    const reply = replies.length > 1 ? replies.shift()! : replies[0]!;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  const cache = createReferences({ request, visible, now: () => now, api: { slots, busyDelays: [] } });
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
  return { cache, ops, advance: (ms: number) => { now += ms; }, settle };
}

describe('the reads behind the references', () => {
  test('nothing is known before the first read; lookups never read, hit or miss', async () => {
    const r = rig([OK]);
    assert.equal(r.cache.lookup('T-1a2b'), null);
    for (let i = 0; i < 1000; i++) { r.cache.lookup('T-1a2b'); r.cache.lookup(`T-${(0x1000 + i).toString(16)}`); }
    await r.settle();
    assert.deepEqual(r.ops, [], 'a lookup alone sends nothing');
    r.cache.tick(); r.cache.tick(); await r.settle();
    assert.deepEqual(r.ops, ['ids'], 'one read, none while it is in flight');
    assert.equal(r.cache.lookup('T-1a2b')?.title, 'Ship the first delivery');
    assert.equal(r.cache.lookup('T-9999'), null);
    for (let i = 0; i < 1000; i++) r.cache.lookup('T-9999');
    await r.settle();
    assert.equal(r.ops.length, 1, 'misses are answered from the last read');
  });

  test('at most one read a minute however often it ticks; refresh reads at the next tick', async () => {
    const r = rig([OK]);
    r.cache.tick(); await r.settle();
    for (let second = 1; second < 60; second++) { r.advance(1000); r.cache.tick(); await r.settle(); }
    assert.equal(r.ops.length, 1);
    r.advance(REFERENCES_INTERVAL_MS); r.cache.tick(); await r.settle();
    assert.equal(r.ops.length, 2);
    r.cache.refresh(); r.cache.tick(); r.cache.tick(); await r.settle();
    assert.equal(r.ops.length, 3, 'a refresh reads once at the next tick');
    r.cache.tick(); await r.settle();
    assert.equal(r.ops.length, 3);
  });

  test('a hidden page does not read', async () => {
    let shown = false;
    const r = rig([OK], () => shown);
    r.cache.tick(); await r.settle();
    assert.equal(r.ops.length, 0);
    shown = true; r.cache.tick(); await r.settle();
    assert.equal(r.ops.length, 1);
  });

  test('its read waits for a free slot of the page and takes only one', async () => {
    const slots = readSlots(2);
    assert.ok(await slots.take()); assert.ok(await slots.take());
    const r = rig([OK], () => true, slots);
    r.cache.tick(); await r.settle();
    assert.equal(r.ops.length, 0, 'both slots taken: it waits');
    slots.give(); await r.settle(); await r.settle();
    assert.equal(r.ops.length, 1);
    assert.ok(await slots.take(), 'the slot it used is free again');
  });

  for (const [status, code] of [[503, 'not_available'], [400, 'invalid_input'], [401, 'unauthorized']] as const) {
    test(`${code} (${status}): nothing known, and no read again`, async () => {
      const r = rig([OK, error(status, code)]);
      r.cache.tick(); await r.settle();
      assert.ok(r.cache.lookup('T-1a2b'));
      r.cache.refresh(); r.cache.tick(); await r.settle();
      assert.equal(r.cache.lookup('T-1a2b'), null, 'what was known is gone');
      r.advance(10 * REFERENCES_INTERVAL_MS); r.cache.refresh(); r.cache.tick(); await r.settle();
      assert.equal(r.ops.length, 2, 'stopped for the page');
    });
  }

  test('no tracker: nothing known, read again a minute later; busy keeps what is known; another failure clears it', async () => {
    const r = rig([error(502, 'repository'), OK, error(503, 'busy'), error(502, 'internal')]);
    r.cache.tick(); await r.settle();
    assert.equal(r.cache.lookup('T-1a2b'), null);
    r.advance(REFERENCES_INTERVAL_MS); r.cache.tick(); await r.settle();
    assert.ok(r.cache.lookup('T-1a2b'));
    r.advance(REFERENCES_INTERVAL_MS); r.cache.tick(); await r.settle();
    assert.ok(r.cache.lookup('T-1a2b'), 'busy: kept');
    r.advance(REFERENCES_INTERVAL_MS); r.cache.tick(); await r.settle();
    assert.equal(r.cache.lookup('T-1a2b'), null, 'another failure: cleared');
    assert.equal(r.ops.length, 4);
  });

  test('a read that times out keeps what is known, like busy: the links do not vanish for a minute', async () => {
    const r = rig([OK, error(504, 'timeout'), OK]);
    r.cache.tick(); await r.settle();
    assert.ok(r.cache.lookup('T-1a2b'));
    r.advance(REFERENCES_INTERVAL_MS); r.cache.tick(); await r.settle();
    assert.ok(r.cache.lookup('T-1a2b'), 'timeout: kept');
    r.advance(REFERENCES_INTERVAL_MS); r.cache.tick(); await r.settle();
    assert.equal(r.ops.length, 3, 'read again a minute later');
  });

  test('stop clears what is known and drops a read in flight; no read after it', async () => {
    const r = rig([OK]);
    r.cache.tick(); await r.settle();
    assert.ok(r.cache.lookup('T-1a2b'));
    r.cache.refresh(); r.cache.tick();   // in flight
    r.cache.stop(); await r.settle();
    assert.equal(r.cache.lookup('T-1a2b'), null);
    r.advance(10 * REFERENCES_INTERVAL_MS); r.cache.refresh(); r.cache.tick(); await r.settle();
    assert.equal(r.ops.length, 2);
  });
});
