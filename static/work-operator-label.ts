// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The texts of the Projects view that name the operator (operator-name.ts). The name is read from GET /api/config
 * each time the view opens, and replaced at once when the Configuration dialog saves a new one (the event
 * OPERATOR_NAME_EVENT, whose detail is the saved name): every such text already shown is rewritten in place, so
 * nothing else of the view is drawn again. Until the first read, after a failed read and for an empty name, the texts
 * use the wording without a name. The name is never sent anywhere: it only becomes text.
 */

import { OPERATOR_NAME_EVENT, cleanOperatorName, operatorNameOfConfig } from './operator-name.ts';

/** Builds the whole text of one element from the current name ("" for none). */
export type NamedText = (name: string) => string;

const shown = new WeakMap<Element, NamedText>();
let current = '';
/** Numbers the reads and the saved names: an older read never overwrites a newer name. */
let sequence = 0;

/** Give `node` the text `render` builds, and build it again whenever the name changes. The node keeps text only. */
export function withOperatorName<T extends HTMLElement>(node: T, render: NamedText): T {
  node.dataset.operatorLabel = '';
  node.textContent = render(current);
  shown.set(node, render);
  return node;
}

export function setOperatorName(name: string, scope: ParentNode = document): void {
  sequence += 1;
  current = cleanOperatorName(name);
  for (const node of scope.querySelectorAll('[data-operator-label]')) {
    const render = shown.get(node);
    if (render) node.textContent = render(current);
  }
}

/** Read the name through the configuration API; any failure means no name. */
export async function loadOperatorName(request: (input: string, init: RequestInit) => Promise<Response>): Promise<void> {
  const mine = ++sequence;
  let name = '';
  try {
    const response = await request('/api/config', { cache: 'no-store' });
    if (response.ok) name = operatorNameOfConfig(await response.json());
  } catch { /* no name: the wording without one */ }
  if (mine === sequence) setOperatorName(name);
}

if (typeof window !== 'undefined') {
  window.addEventListener(OPERATOR_NAME_EVENT, event => {
    const detail = (event as CustomEvent<unknown>).detail;
    setOperatorName(typeof detail === 'string' ? detail : '');
  });
}
