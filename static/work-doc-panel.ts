// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The document panel of the Projects view: a document reference in tracker text (static/work-linkify.ts) opens here,
 * beside the view on a wide screen and over it on a phone. It reuses the document panel's server side unchanged in
 * its policy: POST /api/view decides whether the path may be shown (the view roots and the protected folders of
 * view.py, a browser cookie or the master token only: a session token is refused) and answers a signed /view URL.
 *
 * The frame is stricter than the terminal side's: an HTML or SVG page gets an empty sandbox (no script, opaque
 * origin, no popups, no top navigation) and is asked for as a static page (`?static=1`: a CSP without any script
 * source); rendered Markdown, diffs and text keep the server's renderer, whose CSP runs nothing but its own scripts by
 * nonce. The panel keeps nothing: closing it removes the frame, and no path or URL is stored.
 */

import type { Translate } from './work-dom.ts';

export type DocRequest = (input: string, init: RequestInit) => Promise<Response>;
export type DocPanelOptions = Readonly<{ root: HTMLElement; request: DocRequest; translate: Translate; origin?: string }>;
export type DocPanel = Readonly<{ open: (path: string, opener?: HTMLElement | null) => Promise<void>; close: () => void; destroy: () => void }>;
export type Viewer = Readonly<{ kind: 'frame'; sandbox: string | null; static: boolean }> | Readonly<{ kind: 'image' }>;

const STATIC_PAGES = new Set(['.html', '.htm', '.svg']);
const RENDERED = new Set(['.md', '.markdown', '.diff', '.patch', '.txt']);
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/** How a document of extension `ext` is shown; `inert`: the server serves it without a sandbox (PDF, images). */
export function viewerFor(ext: string, inert: boolean): Viewer | null {
  if (STATIC_PAGES.has(ext)) return inert ? null : { kind: 'frame', sandbox: '', static: true };
  if (RENDERED.has(ext)) return inert ? null : { kind: 'frame', sandbox: 'allow-scripts', static: false };
  if (IMAGES.has(ext)) return inert ? { kind: 'image' } : null;
  if (ext === '.pdf') return inert ? { kind: 'frame', sandbox: null, static: false } : null;
  return null;
}

/** The absolute URL of a signed document URL answered by /api/view, or null for anything else. */
export function viewUrlOf(url: unknown, origin: string): string | null {
  if (typeof url !== 'string' || !url.startsWith('/view/v2.')) return null;
  let parsed: URL;
  try { parsed = new URL(url, origin); } catch { return null; }
  if (parsed.origin !== origin || parsed.search || parsed.hash || parsed.username || parsed.password) return null;
  return parsed.pathname.startsWith('/view/v2.') ? parsed.href : null;
}

type Shown = Readonly<{ url: string; viewer: Viewer; name: string }>;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

class Panel implements DocPanel {
  private readonly options: DocPanelOptions;
  private readonly t: Translate;
  private readonly origin: string;
  private readonly aside = element('aside', 'work-doc-panel');
  private readonly title = element('h2', 'work-doc-title');
  private readonly newTab = element('a', 'btn work-doc-newtab');
  private readonly body = element('div', 'work-doc-body');
  private opener: HTMLElement | null = null;
  private sequence = 0;
  private readonly onClick = (event: MouseEvent): void => this.clicked(event);
  private readonly onKey = (event: KeyboardEvent): void => this.escape(event);

  constructor(options: DocPanelOptions) {
    this.options = options;
    this.t = options.translate;
    this.origin = options.origin ?? location.origin;
    this.aside.hidden = true;
    this.title.tabIndex = -1;
    this.newTab.target = '_blank';
    this.newTab.rel = 'noopener noreferrer';
    this.newTab.referrerPolicy = 'no-referrer';
    this.newTab.textContent = this.t('work.doc.newTab');
    const close = element('button', 'btn work-doc-close', this.t('work.doc.close'));
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    const head = element('header', 'work-doc-head');
    head.append(this.title, element('span', 'work-doc-actions'));
    head.lastElementChild!.append(this.newTab, close);
    this.aside.append(head, this.body);
    options.root.addEventListener('click', this.onClick);
    window.addEventListener('keydown', this.onKey, true);
  }

  private clicked(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-doc-path]') : null;
    if (!target || !this.options.root.contains(target) || this.aside.contains(target)) return;
    event.preventDefault();
    void this.open(target.dataset.docPath ?? '', target);
  }

  /** Escape closes the panel first (before the task sheet or the view itself), and focus goes back to the link. */
  private escape(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || this.aside.hidden || this.options.root.closest('[hidden]')) return;
    const target = event.target;
    if (target !== document.body && !(target instanceof Node && this.options.root.contains(target))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.close();
  }

  open = async (path: string, opener: HTMLElement | null = null): Promise<void> => {
    const sequence = ++this.sequence;
    this.opener = opener;
    const name = path.slice(path.lastIndexOf('/') + 1);
    this.show(name);
    this.body.replaceChildren(element('p', 'work-doc-status', this.t('work.doc.loading')));
    const shown = await this.describe(path, name);
    if (sequence !== this.sequence || this.aside.hidden) return;
    if (!shown) {
      this.newTab.hidden = true;
      this.body.replaceChildren(element('p', 'work-doc-status work-doc-unavailable', this.t('work.doc.unavailable')));
      return;
    }
    const href = shown.viewer.kind === 'frame' && shown.viewer.static ? `${shown.url}?static=1` : shown.url;
    this.newTab.href = href;
    this.newTab.hidden = false;
    this.newTab.setAttribute('aria-label', this.t('work.doc.newTabLabel', { name }));
    this.body.replaceChildren(this.viewerNode(shown, href));
  };

  private show(name: string): void {
    this.title.textContent = name;
    this.aside.setAttribute('aria-label', this.t('work.doc.label', { name }));
    this.newTab.hidden = true;
    this.newTab.removeAttribute('href');
    this.aside.hidden = false;
    if (!this.aside.isConnected) this.options.root.append(this.aside);   // in the page only while open
    this.options.root.classList.add('work-doc-open');
    this.title.focus();
  }

  private async describe(path: string, name: string): Promise<Shown | null> {
    try {
      const response = await this.options.request('/api/view', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: path }), redirect: 'error', cache: 'no-store' });
      if (!response.ok) return null;
      const descriptor: unknown = await response.json();
      if (!descriptor || typeof descriptor !== 'object') return null;
      const { url, ext, inert } = descriptor as Record<string, unknown>;
      const viewer = typeof ext === 'string' ? viewerFor(ext.toLowerCase(), inert === true) : null;
      const absolute = viewUrlOf(url, this.origin);
      return viewer && absolute ? { url: absolute, viewer, name } : null;
    } catch {
      return null;
    }
  }

  private viewerNode(shown: Shown, href: string): HTMLElement {
    if (shown.viewer.kind === 'image') {
      const image = element('img', 'work-doc-image');
      image.alt = shown.name;
      image.referrerPolicy = 'no-referrer';
      image.src = href;
      return image;
    }
    const frame = element('iframe', 'work-doc-frame');
    if (shown.viewer.sandbox !== null) frame.setAttribute('sandbox', shown.viewer.sandbox);
    frame.referrerPolicy = 'no-referrer';
    frame.title = shown.name;
    frame.src = href;
    return frame;
  }

  close = (): void => {
    if (this.aside.hidden) return;
    this.sequence++;
    this.aside.hidden = true;
    this.options.root.classList.remove('work-doc-open');
    this.body.replaceChildren();
    this.newTab.removeAttribute('href');
    this.aside.remove();
    const opener = this.opener;
    this.opener = null;
    if (opener?.isConnected) opener.focus();
  };

  destroy = (): void => {
    this.close();
    this.options.root.removeEventListener('click', this.onClick);
    window.removeEventListener('keydown', this.onKey, true);
    this.aside.remove();
  };
}

export function mountDocPanel(options: DocPanelOptions): DocPanel { return new Panel(options); }
