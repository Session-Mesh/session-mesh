// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * Links in the text of the Projects view. Question, answer, note, blocker and log text is tracker data written by
 * agents: it is never parsed as HTML. A strict scanner finds two kinds of references in it, and everything else stays
 * a text node:
 *
 * - a web link: `http://` or `https://` (the same schemes as the links of a terminal, static/app.js isExternalUrl),
 *   ASCII only, no user or password, at most MAX_URL characters. It opens in a new tab without opener or referrer.
 * - a document: an absolute (`/…`) or home (`~/…`) path, ASCII only, without empty, `.` or `..` components or any
 *   component starting with a dot, ending in one of DOC_EXTENSIONS. It becomes a button that opens the document in the
 *   side panel (static/work-doc-panel.ts); the server decides whether the file may be shown (POST /api/view).
 *
 * A reference glued to anything that is not plain ASCII (a confusable letter, a bidi or zero-width character) is not a
 * reference at all: the whole word stays text, so the visible text is always exactly what the link points to.
 */

import type { Translate } from './work-dom.ts';

export type Reference = Readonly<{ kind: 'url' | 'doc'; start: number; end: number; value: string; name: string }>;

export const MAX_URL = 2048;
export const MAX_PATH = 1024;
const MAX_SEGMENT = 255;
const DOC_EXTENSIONS = /\.(?:html?|md|markdown|svg|pdf|png|jpe?g|gif|webp|txt|diff|patch)$/i;
// RFC 3986 unreserved and reserved characters, without the brackets, parentheses and quote that wrap links in prose.
const URL_CHAR = /[A-Za-z0-9\-._~:/?#@!$&*+,;=%]/;
const PATH_CHAR = /[A-Za-z0-9_@%+=,.\-/]/;
const SEGMENT = /^[A-Za-z0-9_@%+=,-][A-Za-z0-9_@%+=,.-]*$/;
// What may follow a reference: the end, a space, or ASCII punctuation that is not part of one.
const TERMINATOR = /[\s()[\]{}<>"'`|\\^]/;
// What may come right before a document path: nothing, a space, or an opening wrapper.
const PATH_OPENER = /[\s(["'<`*]/;
const TRAILING_URL = /[.,;:!?*]+$/;
const TRAILING_PATH = /[.,]+$/;
/** At most this many references of each kind in one text; the rest stays text. */
const MAX_REFERENCES = 200;

/** The end of the run of `allowed` characters from `from`. */
function runEnd(text: string, from: number, allowed: RegExp): number {
  let end = from;
  while (end < text.length && allowed.test(text[end]!)) end++;
  return end;
}

/** The index of the next whitespace from `from` (or the end): where a rejected word ends. */
function wordEnd(text: string, from: number): number {
  let end = from;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  return end;
}

/** A run may only be followed by the end, a space or a terminator; anything else rejects the whole word. */
const endsCleanly = (text: string, end: number): boolean => end >= text.length || TERMINATOR.test(text[end]!);

/** `raw` as the href of a web link, or null: http(s), a host, no credentials, ASCII only, within MAX_URL. */
export function webUrl(raw: string): string | null {
  if (raw.length > MAX_URL || !/^https?:\/\/[A-Za-z0-9]/i.test(raw)) return null;
  for (const char of raw) if (!URL_CHAR.test(char)) return null;
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.href;
}

/** `raw` as a document path, or null (see the module comment for what a document path is). */
export function documentPath(raw: string): string | null {
  if (raw.length > MAX_PATH || !DOC_EXTENSIONS.test(raw)) return null;
  const rest = raw.startsWith('~/') ? raw.slice(2) : raw.startsWith('/') ? raw.slice(1) : null;
  if (rest === null) return null;
  const segments = rest.split('/');
  return segments.every(segment => segment.length <= MAX_SEGMENT && SEGMENT.test(segment)) ? raw : null;
}

function urlReferences(text: string): Reference[] {
  const out: Reference[] = [];
  const scheme = /https?:\/\//gi;
  let match: RegExpExecArray | null;
  while (out.length < MAX_REFERENCES && (match = scheme.exec(text)) !== null) {
    const start = match.index;
    if (start > 0 && /[A-Za-z0-9]/.test(text[start - 1]!)) continue;   // "xhttps://" is not a link
    const end = runEnd(text, start, URL_CHAR);
    scheme.lastIndex = end;
    if (!endsCleanly(text, end)) { scheme.lastIndex = wordEnd(text, end); continue; }
    const value = text.slice(start, end).replace(TRAILING_URL, '');
    if (webUrl(value) !== null) out.push({ kind: 'url', start, end: start + value.length, value, name: value });
  }
  return out;
}

function docReferences(text: string): Reference[] {
  const out: Reference[] = [];
  let index = 0;
  while (out.length < MAX_REFERENCES && index < text.length) {
    const at = text.indexOf('/', index);
    if (at < 0) break;
    const start = at > 0 && text[at - 1] === '~' ? at - 1 : at;
    const before = start > 0 ? text[start - 1]! : ' ';
    if (!PATH_OPENER.test(before)) { index = at + 1; continue; }
    const end = runEnd(text, at, PATH_CHAR);
    if (!endsCleanly(text, end)) { index = wordEnd(text, end); continue; }
    const value = text.slice(start, end).replace(TRAILING_PATH, '');
    index = end;
    if (documentPath(value) !== null) {
      out.push({ kind: 'doc', start, end: start + value.length, value, name: value.slice(value.lastIndexOf('/') + 1) });
    }
  }
  return out;
}

/** The references in `text`, in order, never overlapping (a path inside a web link is part of the link). */
export function findReferences(text: string): Reference[] {
  const urls = urlReferences(text);
  const docs = docReferences(text).filter(doc => !urls.some(url => doc.start < url.end && url.start < doc.end));
  return [...urls, ...docs].sort((a, b) => a.start - b.start);
}

function webLink(value: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'work-link';
  link.href = webUrl(value)!;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.referrerPolicy = 'no-referrer';
  link.textContent = value;
  return link;
}

function docButton(t: Translate, ref: Reference): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'work-doc-link';
  button.dataset.docPath = ref.value;
  button.title = ref.value;
  button.setAttribute('aria-label', t('work.doc.openLabel', { name: ref.name, path: ref.value }));
  const icon = document.createElement('span');
  icon.className = 'work-doc-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '📄';
  button.append(icon, ref.name);
  return button;
}

/** `text` as text nodes, with its web links and document references as links and buttons. */
export function linkText(t: Translate, text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let position = 0;
  for (const ref of findReferences(text)) {
    if (ref.start > position) fragment.append(text.slice(position, ref.start));
    fragment.append(ref.kind === 'url' ? webLink(ref.value) : docButton(t, ref));
    position = ref.end;
  }
  if (position < text.length) fragment.append(text.slice(position));
  return fragment;
}
