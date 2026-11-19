// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Drawing a list from markup without rebuilding it. Generic: the caller names the attributes that
// identify a child and which elements are leaves (static/app.js passes the sidebar's).
//   - createFrameBatcher: any number of render requests in a frame make one render;
//   - morphChildren: the new markup is applied by key, so a child whose markup did not change keeps
//     its DOM node (and its focus, hover and drag state), and only changed leaves are replaced.
//     A node holding the focus, or one the caller keeps, is never moved: the others are placed
//     around it (moving a focused element out of the document and back drops its focus).

export type FrameApi = { request(run: () => void): number; cancel(handle: number): void };

/** `cancel` says whether a render was pending (the caller then owes whatever else that render did). */
export type FrameBatcher = { request(): void; flush(): void; pending(): boolean; cancel(): boolean };

/** At most one call of `render` per animation frame, however many requests the frame received. */
export function createFrameBatcher(render: () => void, frames: FrameApi): FrameBatcher {
  let handle: number | null = null;
  const run = () => { handle = null; render(); };
  return {
    request() { if (handle === null) handle = frames.request(run); },
    flush() { if (handle === null) return; frames.cancel(handle); run(); },
    pending: () => handle !== null,
    cancel() {
      if (handle === null) return false;
      frames.cancel(handle);
      handle = null;
      return true;
    },
  };
}

export type MorphConfig = {
  keyAttributes: readonly string[];   // the first one present names a child among its siblings
  isLeaf: (element: Element) => boolean;   // replaced whole when it changes (others are updated in place)
  keep?: (element: Element) => boolean;   // never touched when present on both sides
};

/** The identity of a node among its siblings (an occurrence count makes repeated keys distinct). */
export function nodeKey(node: Node, keyAttributes: readonly string[]): string {
  if (node.nodeType !== 1) return `#${node.nodeName}`;
  const element = node as Element;
  for (const name of keyAttributes) {
    const value = element.getAttribute(name);
    if (value !== null) return `${element.tagName}|${name}=${value}`;
  }
  return `${element.tagName}|.${element.classList[0] ?? ""}`;
}

/** Keys with their occurrence: ["A", "B", "A"] -> ["A#0", "B#0", "A#1"]. */
export function occurrenceKeys(keys: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return `${key}#${n}`;
  });
}

function syncAttributes(target: Element, source: Element): void {
  for (const { name } of [...target.attributes]) if (!source.hasAttribute(name)) target.removeAttribute(name);
  for (const { name, value } of [...source.attributes]) if (target.getAttribute(name) !== value) target.setAttribute(name, value);
}

const isElement = (node: Node): node is Element => node.nodeType === 1;
const isContainer = (element: Element, config: MorphConfig) => !config.isLeaf(element) && element.firstElementChild !== null;

/** The node to use for `fresh`: the old one with the same key when it can be kept or updated, else `fresh`. */
function reuse(old: Node | undefined, fresh: Node, config: MorphConfig, count: { created: number }): Node {
  if (old && isElement(old) && config.keep?.(old)) return old;
  if (old && old.isEqualNode(fresh)) return old;
  if (old && isElement(old) && isElement(fresh) && old.tagName === fresh.tagName && isContainer(fresh, config) && isContainer(old, config)) {
    syncAttributes(old, fresh);
    count.created += morphChildren(old, fresh, config);
    return old;
  }
  if (old && old.nodeType === 3 && fresh.nodeType === 3) {
    if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
    return old;
  }
  count.created += 1;
  return fresh;
}

/** A node that must not be moved: it holds the focus, or the caller keeps it. */
function anchored(node: Node, config: MorphConfig): boolean {
  if (!isElement(node)) return false;
  const focused = node.ownerDocument.activeElement;
  return (focused !== null && node.contains(focused)) || config.keep?.(node) === true;
}

/**
 * Put `nodes` in `target` in that order. Every node of `target` is one of them. An anchored node is
 * never moved: met after the cursor, it stays and the nodes between are moved after it; met before
 * the cursor (two anchored nodes whose order changed), it stays where it is, out of order until it
 * is released.
 */
function place(target: Element, nodes: readonly Node[], config: MorphConfig): void {
  let cursor: Node | null = target.firstChild;
  for (const node of nodes) {
    if (node === cursor) { cursor = cursor.nextSibling; continue; }
    if (node.parentNode === target && anchored(node, config)) {
      const ahead = cursor !== null && (cursor.compareDocumentPosition(node) & 4 /* Node.DOCUMENT_POSITION_FOLLOWING */) !== 0;
      if (ahead) cursor = node.nextSibling;
      continue;
    }
    target.insertBefore(node, cursor);
  }
}

/**
 * Make `target`'s children match `source`'s, reusing every child whose key and markup are unchanged.
 * Unused old children are removed before any is moved. Returns the number of nodes created.
 */
export function morphChildren(target: Element, source: Element, config: MorphConfig): number {
  const oldNodes = [...target.childNodes];
  const oldKeys = occurrenceKeys(oldNodes.map((node) => nodeKey(node, config.keyAttributes)));
  const byKey = new Map(oldKeys.map((key, i) => [key, oldNodes[i]!]));
  const freshNodes = [...source.childNodes];
  const freshKeys = occurrenceKeys(freshNodes.map((node) => nodeKey(node, config.keyAttributes)));
  const count = { created: 0 };
  const nodes = freshNodes.map((fresh, i) => reuse(byKey.get(freshKeys[i]!), fresh, config, count));
  const used = new Set(nodes);
  for (const old of oldNodes) if (!used.has(old) && old.parentNode === target) target.removeChild(old);
  place(target, nodes, config);
  return count.created;
}
