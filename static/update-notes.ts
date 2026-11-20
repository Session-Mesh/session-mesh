// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// "What's new": the release notes of the release the update banner announces, in a dialog of the page,
// rendered with the document viewer's Markdown parser and sanitizer (marked and DOMPurify, from /viewlib).
// The notes come from the server (GET /api/update/notes: what the PTY host kept from the releases list it
// already fetches for the banner); their images from the server's proxy (GET /api/update/image), which
// fetches only images written in those notes, on GitHub's hosts. This page never contacts GitHub: the only
// way there is a link the reader opens in a new tab.
import { markdownLibraries } from "./project-markdown.ts";

type Translate = (key: string, params?: Record<string, string>) => string;
export type Notes = { tag: string; published: string; body: string; truncated: boolean; notesUrl: string };

// The host keeps at most 64 KiB of notes (ocaml/lib/mesh_update_check.ml); a JavaScript string counts UTF-16
// units, never more than the bytes.
export const NOTES_LIMIT = 65536;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const IMAGE_HOST = /^(github\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.githubusercontent\.com)$/;

// The server's answer for release `tag`, or null when it is not exactly what the host produces.
export function parseNotes(raw: unknown, tag: string): Notes | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const { published, body, truncated, notes_url: notesUrl } = value;
  if (value.tag !== tag || typeof body !== "string" || body.length > NOTES_LIMIT || typeof truncated !== "boolean") return null;
  if (typeof published !== "string" || (published !== "" && !DATE.test(published))) return null;
  if (typeof notesUrl !== "string" || !notesUrl.startsWith("https://github.com/") || !notesUrl.endsWith(`/releases/tag/${tag}`)
    || /[\s"'<>\\]/.test(notesUrl)) return null;
  return { tag, published, body, truncated, notesUrl };
}

function absolute(text: unknown): URL | null {
  if (typeof text !== "string" || !/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  try { return new URL(text); } catch { return null; }
}

// A link of the notes: an absolute http(s) URL without credentials, else null (the text stays, not the link).
export function safeLink(href: unknown): string | null {
  const url = absolute(href);
  return url && (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
}

// The proxy URL for an image of the notes, or null when the server would refuse it (it checks again).
export function imageSource(src: unknown): string | null {
  const url = absolute(src);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port !== "" || !IMAGE_HOST.test(url.hostname)) return null;
  return `/api/update/image?url=${encodeURIComponent(src as string)}`;
}

// The notes' own HTML never runs and never reaches the page's state: no script (the page's CSP allows
// none inline), no forms, frames, styles, SVG or MathML, no id, name or class (they could clobber or
// restyle the interface's own elements).
const PURIFY = {
  USE_PROFILES: { html: true },
  ALLOW_DATA_ATTR: false,
  RETURN_DOM_FRAGMENT: true,
  FORBID_TAGS: ["style", "form", "iframe", "frame", "object", "embed", "meta", "link", "base", "svg", "math", "picture",
    "source", "video", "audio", "input", "button", "textarea", "select", "dialog", "template"],
  FORBID_ATTR: ["style", "id", "name", "class", "srcset", "background", "ping", "autofocus", "contenteditable", "tabindex",
    "usemap", "formaction"],
};

// A link (or plain text) that stands for an image the page does not show.
function imageStandIn(doc: Document, image: HTMLImageElement, t: Translate): HTMLElement {
  const label = image.getAttribute("alt")?.trim() || t("update.notesImage");
  const href = safeLink(image.getAttribute("src"));
  const node = doc.createElement(href ? "a" : "span");
  node.className = "update-notes-image";
  node.textContent = label;
  if (node instanceof HTMLAnchorElement && href) {
    node.href = href;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
  }
  return node;
}

// Links open in a new tab without the page as opener; images come from the proxy or are replaced by a link.
// Done on the sanitized fragment, before it is in the page: no image of the notes is ever requested as written.
export function present(fragment: DocumentFragment, doc: Document, t: Translate): void {
  for (const anchor of fragment.querySelectorAll("a")) {
    const href = safeLink(anchor.getAttribute("href"));
    for (const name of [...anchor.getAttributeNames()]) if (name !== "title") anchor.removeAttribute(name);
    if (!href) continue;
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  for (const image of fragment.querySelectorAll("img")) {
    const source = imageSource(image.getAttribute("src"));
    if (!source) { image.replaceWith(imageStandIn(doc, image, t)); continue; }
    const shown = doc.createElement("img");
    for (const name of ["alt", "title", "width", "height"] as const) {
      const value = image.getAttribute(name);
      if (value !== null && (name === "alt" || name === "title" || /^\d{1,4}$/.test(value))) shown.setAttribute(name, value);
    }
    shown.loading = "lazy";
    shown.decoding = "async";
    shown.referrerPolicy = "no-referrer";
    // refused by the proxy (not an image, too large, unreachable): a link to it instead
    shown.addEventListener("error", () => shown.replaceWith(imageStandIn(doc, image, t)), { once: true });
    shown.src = source;
    image.replaceWith(shown);
  }
}

function formatDate(published: string, language: string): string {
  if (!published) return "";
  try { return new Intl.DateTimeFormat(language, { dateStyle: "long", timeZone: "UTC" }).format(new Date(published)); }
  catch { return published.slice(0, 10); }
}

function element<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function githubLink(doc: Document, url: string, text: string): HTMLAnchorElement {
  const link = doc.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = text;
  return link;
}

type Announced = { latest: string; notesUrl: string };

function buildDialog(doc: Document, notice: Announced, t: Translate) {
  const dialog = element(doc, "dialog", "update-notes");
  dialog.setAttribute("aria-labelledby", "update-notes-title");
  const head = element(doc, "header", "update-notes-head");
  const titles = element(doc, "div", "update-notes-titles");
  const title = element(doc, "h2", "update-notes-title", t("update.notesTitle", { version: notice.latest }));
  title.id = "update-notes-title";
  const meta = element(doc, "p", "update-notes-meta");
  const date = element(doc, "time", "update-notes-date");
  meta.append(date, githubLink(doc, notice.notesUrl, t("update.notesGithub")));
  titles.append(title, meta);
  const close = element(doc, "button", "update-notes-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", t("update.notesClose"));
  close.title = t("update.notesClose");
  close.addEventListener("click", () => dialog.close());
  head.append(titles, close);
  const body = element(doc, "div", "update-notes-body");
  body.tabIndex = 0;   // long notes scroll with the keyboard
  body.setAttribute("aria-busy", "true");
  body.append(element(doc, "p", "update-notes-status", t("update.notesLoading")));
  dialog.append(head, body);
  return { dialog, body, date, close };
}

async function fetchNotes(tag: string): Promise<Notes | null> {
  const answer = await fetch("/api/update/notes", { credentials: "same-origin", cache: "no-store" });
  return answer.ok ? parseNotes(await answer.json(), tag) : null;
}

async function fill(parts: ReturnType<typeof buildDialog>, notice: Announced, t: Translate, language: string): Promise<void> {
  const doc = parts.body.ownerDocument;
  const failed = () => {
    const status = element(doc, "p", "update-notes-status");
    status.setAttribute("role", "alert");
    status.append(t("update.notesFailed"), " ", githubLink(doc, notice.notesUrl, t("update.notesGithub")));
    parts.body.replaceChildren(status);
  };
  try {
    const notes = await fetchNotes(notice.latest);
    if (!notes) { failed(); return; }
    const win = await markdownLibraries(doc);
    const html = win.marked!.parse(notes.body, { gfm: true, async: false });
    const fragment = (win.DOMPurify!.sanitize as unknown as (html: string, options: object) => DocumentFragment)(html, PURIFY);
    present(fragment, doc, t);
    if (notes.published) {
      parts.date.dateTime = notes.published;
      parts.date.textContent = t("update.notesPublished", { date: formatDate(notes.published, language) });
    }
    const content = element(doc, "div", "update-notes-markdown");
    content.append(fragment);
    if (notes.truncated) content.append(element(doc, "p", "update-notes-status", t("update.notesTruncated")));
    parts.body.replaceChildren(content);
  } catch {   // the server, the network or the Markdown libraries failed
    failed();
  } finally {
    parts.body.removeAttribute("aria-busy");
  }
}

// Opens the panel over the page; Escape or the close button closes it and gives the focus back to `opener`.
export function openNotes(doc: Document, notice: Announced, t: Translate, language: string, opener: HTMLElement): void {
  doc.querySelector("dialog.update-notes")?.remove();
  const parts = buildDialog(doc, notice, t);
  parts.dialog.addEventListener("close", () => {
    parts.dialog.remove();
    if (opener.isConnected) opener.focus();
  }, { once: true });
  doc.body.append(parts.dialog);
  parts.dialog.showModal();
  parts.close.focus();
  void fill(parts, notice, t, language);
}
