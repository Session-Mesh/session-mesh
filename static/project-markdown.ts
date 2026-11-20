// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Reuse the same local Markdown parser and sanitizer as the document viewer.
// README input is an observed repository blob, never trusted application HTML.
interface MarkdownWindow extends Window {
  marked?: { parse: (text: string, options: { gfm: boolean; async: false }) => string };
  DOMPurify?: { sanitize: (html: string, options: Record<string, unknown>) => string };
}
const libraries = new WeakMap<Document, Promise<MarkdownWindow>>();
export async function markdownLibraries(doc: Document): Promise<MarkdownWindow> {
  let pending = libraries.get(doc);
  if (!pending) {
    pending = (async () => {
      const win = doc.defaultView as MarkdownWindow | null;
      if (!win) throw Error('Document unavailable');
      for (const [name, file] of [['marked', 'marked.min.js'], ['DOMPurify', 'purify.min.js']] as const) {
        if (win[name]) continue;
        await new Promise<void>((resolve, reject) => {
          const script = doc.createElement('script'); script.src = '/viewlib/' + file;
          script.onload = () => resolve(); script.onerror = () => reject(Error('Markdown unavailable'));
          doc.head.append(script);
        });
      }
      if (!win.marked || !win.DOMPurify) throw Error('Markdown unavailable');
      return win;
    })();
    libraries.set(doc, pending);
    void pending.catch(() => { libraries.delete(doc); });
  }
  return pending;
}
export async function renderProjectMarkdown(node: HTMLElement, text: string, options:{preserveFrontmatter?:boolean}={}): Promise<void> {
  if (node.dataset.markdownState === 'rendered' || node.dataset.markdownState === 'loading') return;
  node.dataset.markdownState = 'loading';
  try {
    const win = await markdownLibraries(node.ownerDocument);
    const source = options.preserveFrontmatter?text:text.replace(/^---\n[\s\S]*?\n---\n/, '');
    const scroll = node.scrollTop;
    node.innerHTML = win.DOMPurify!.sanitize(win.marked!.parse(source, { gfm: true, async: false }), {
      USE_PROFILES: { html: true },
      ALLOW_DATA_ATTR: false,
      // An inline README has less authority than the sandboxed document viewer:
      // no resource requests, controls, style overrides or application IDs.
      FORBID_TAGS: ['style', 'form', 'iframe', 'frame', 'object', 'embed', 'meta', 'link', 'base', 'img', 'picture', 'source', 'video', 'audio', 'input', 'button', 'textarea', 'select'],
      FORBID_ATTR: ['style', 'id', 'name', 'class', 'src', 'srcset', 'background', 'ping', 'autofocus', 'contenteditable'],
    });
    for (const anchor of node.querySelectorAll('a')) {
      const href = anchor.getAttribute('href');
      // Relative repository paths must not become requests against the Mesh UI.
      // Explicit external links remain useful without creating implicit reads.
      try {
        const url = new URL(href ?? '');
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Unsafe link');
        anchor.href = url.href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
      } catch { anchor.removeAttribute('href'); }
    }
    node.dataset.markdownState = 'rendered';
    node.scrollTop = scroll;
  } catch {
    // Parser loading can fail independently of project data and the terminal.
    // The readable source remains available, contained inside the disclosure.
    node.textContent = text; node.dataset.markdownState = 'source';
  }
}
