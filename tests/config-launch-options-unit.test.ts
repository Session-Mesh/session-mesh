// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LaunchEditor, parseLaunch} from '../static/config-launch-editor.ts';

class Element {
  className = ''; textContent = ''; dataset: Record<string, string> = {}; children: Element[] = [];
  value = ''; type = ''; disabled = false; checked = false; listeners = new Map<string, () => void>();
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(_name: string, _value: string) {}
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  querySelector(_selector: string) { return null; }
  get lastElementChild() { return this.children.at(-1); }
}
const document = {createElement: (tag: string) => new Element(tag), createTextNode: () => new Element('#text'),
  defaultView: {confirm: (_message: string) => true}};
function all(element: Element): Element[] { return [element, ...element.children.flatMap(all)]; }

test('options can be edited with no launch settings file', async () => {
  const view = parseLaunch({editable: false, revision: null, agent_options_editable: true,
    agent_options_revision: 'options-rev', known_agents: ['codex'], defaults: {}, limits: {}});
  const saves: unknown[] = [];
  const editor = new LaunchEditor(document as unknown as Document, view, {active: true, secondsLeft: 60}, {
    t: (key) => key, elevate: async () => ({ok: true, secondsLeft: 60}), revoke: async () => true,
    save: async () => { throw new Error('launch settings must not be saved'); },
    saveOptions: async (body) => { saves.push(body); return {ok: true}; }, reload: () => {},
  });
  try {
    const nodes = all(editor.element as unknown as Element);
    assert.ok(nodes.some((node) => node.className.includes('config-options')));
    assert.ok(!nodes.some((node) => node.className.includes('config-new-root') || node.className === 'btn sm primary config-save'));
    const input = nodes.find((node) => node.dataset.optionAgent === 'codex')!;
    input.value = '--search'; input.listeners.get('input')!();
    nodes.find((node) => node.className.includes('config-save-options'))!.listeners.get('click')!();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(saves, [{revision: 'options-rev', agent_options: {codex: '--search'}}]);
  } finally { editor.dispose(); }
});

test('unreadable options do not become editable through an existing elevation', () => {
  const view = parseLaunch({editable: false, revision: null, agent_options_editable: false,
    agent_options_error: 'unreadable', known_agents: ['codex'], defaults: {}, limits: {}});
  const editor = new LaunchEditor(document as unknown as Document, view, {active: true, secondsLeft: 60}, {
    t: (key) => key, elevate: async () => ({ok: true, secondsLeft: 60}), revoke: async () => true,
    save: async () => ({ok: true}), saveOptions: async () => ({ok: true}), reload: () => {},
  });
  try {
    assert.ok(!all(editor.element as unknown as Element).some((node) => node.className.includes('config-options')));
  } finally { editor.dispose(); }
});

for (const first of ['options', 'launch'] as const) {
  test(`saving ${first} asks before discarding the other draft`, async () => {
    const view = parseLaunch({editable: true, revision: 'launch-rev', enabled_agents: ['codex'],
      workspace_roots: ['/work'], known_agents: ['codex', 'claude'], agent_options_editable: true,
      agent_options_revision: 'options-rev', defaults: {}, limits: {}});
    let answer = false, prompts = 0, saves = 0;
    const doc = {...document, defaultView: {confirm: () => { prompts += 1; return answer; }}};
    const editor = new LaunchEditor(doc as unknown as Document, view, {active: true, secondsLeft: 60}, {
      t: (key) => key, elevate: async () => ({ok: true, secondsLeft: 60}), revoke: async () => true,
      save: async () => { saves += 1; return {ok: true}; },
      saveOptions: async () => { saves += 1; return {ok: true}; }, reload: () => {},
    });
    try {
      const nodes = all(editor.element as unknown as Element);
      const agent = nodes.find((node) => node.dataset.agent === 'claude')!;
      agent.checked = true; agent.listeners.get('change')!();
      const input = nodes.find((node) => node.dataset.optionAgent === 'codex')!;
      input.value = '--search'; input.listeners.get('input')!();
      const button = nodes.find((node) => first === 'options'
        ? node.className.includes('config-save-options') : node.className === 'btn sm primary config-save')!;
      button.listeners.get('click')!();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(prompts, 1); assert.equal(saves, 0);
      answer = true; button.listeners.get('click')!();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(prompts, 2); assert.equal(saves, 1);
    } finally { editor.dispose(); }
  });
}

test('an options save finishing after disposal does not reload the new dialog', async () => {
  const view = parseLaunch({editable: false, revision: null, known_agents: ['codex'],
    agent_options_editable: true, agent_options_revision: 'rev', defaults: {}, limits: {}});
  let finish!: (value: {ok: true}) => void, reloads = 0;
  const pending = new Promise<{ok: true}>((resolve) => { finish = resolve; });
  const editor = new LaunchEditor(document as unknown as Document, view, {active: true, secondsLeft: 60}, {
    t: (key) => key, elevate: async () => ({ok: true, secondsLeft: 60}), revoke: async () => true,
    save: async () => ({ok: true}), saveOptions: async () => pending, reload: () => { reloads += 1; },
  });
  const nodes = all(editor.element as unknown as Element);
  const input = nodes.find((node) => node.dataset.optionAgent === 'codex')!;
  input.value = '--search'; input.listeners.get('input')!();
  nodes.find((node) => node.className.includes('config-save-options'))!.listeners.get('click')!();
  editor.dispose(); finish({ok: true});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reloads, 0);
});
