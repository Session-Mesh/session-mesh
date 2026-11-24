// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LaunchEditor, parseLaunch} from '../static/config-launch-editor.ts';

class Element {
  className = ''; textContent = ''; dataset: Record<string, string> = {}; children: Element[] = [];
  value = ''; type = ''; disabled = false; listeners = new Map<string, () => void>();
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(_name: string, _value: string) {}
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  querySelector(_selector: string) { return null; }
  get lastElementChild() { return this.children.at(-1); }
}
const document = {createElement: (tag: string) => new Element(tag), createTextNode: () => new Element('#text')};
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
