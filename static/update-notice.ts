// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The "update available" banner. The server relays what the PTY host's release check found
// (field `update` of /api/sessions); this page never contacts GitHub itself. Dismissing the banner
// is remembered per release in this browser, so it comes back only for a newer one.

export type UpdateNotice = {
  latest: string; security: boolean; notesUrl: string; upgradeCommand: string;
};
type Translate = (key: string, params?: Record<string, string>) => string;
type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void };

export const DISMISSED_KEY = "mesh.update.dismissed";
const TAG = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
// The release page of that tag on GitHub (the repository is named once, by the server's answer).
const notesFor = (url: string, tag: string) =>
  url.startsWith("https://github.com/") && url.endsWith(`/releases/tag/${tag}`) && !/[\s"'<>\\]/.test(url);

function parts(tag: string): number[] | null {
  const match = TAG.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

// Positive when release tag `left` is newer than `right`; release tags only (no pre-release).
export function compareTags(left: string, right: string): number {
  const a = parts(left), b = parts(right);
  if (!a || !b) return Number.NaN;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

// The server's answer, or null when it is absent or not exactly what update-check produces.
export function parseNotice(raw: unknown): UpdateNotice | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const { latest, security, notes_url: notesUrl, upgrade_command: upgradeCommand } = value;
  if (value.status !== "available" || typeof latest !== "string" || !TAG.test(latest)) return null;
  if (typeof security !== "boolean" || typeof notesUrl !== "string" || !notesFor(notesUrl, latest)) return null;
  if (typeof upgradeCommand !== "string" || upgradeCommand.length > 4096) return null;
  return { latest, security, notesUrl, upgradeCommand };
}

// The newest release closed on this page. Without a usable store (blocked storage, a private window)
// it is what keeps a closed banner closed at the next poll; a reload forgets it.
let dismissedOnThisPage = "";

function readDismissed(store: Store | null): string {
  let stored = "";
  try { stored = store?.getItem(DISMISSED_KEY) ?? ""; } catch { /* the page's own memory below */ }
  return compareTags(dismissedOnThisPage, stored) > 0 || (!parts(stored) && parts(dismissedOnThisPage))
    ? dismissedOnThisPage : stored;
}

// Shown unless this release, or a newer one, was dismissed in this browser.
export function shouldShow(notice: UpdateNotice, store: Store | null): boolean {
  const dismissed = readDismissed(store);
  return !(compareTags(dismissed, notice.latest) >= 0);
}

export function dismiss(notice: UpdateNotice, store: Store | null): void {
  if (!(compareTags(dismissedOnThisPage, notice.latest) >= 0)) dismissedOnThisPage = notice.latest;
  try { store?.setItem(DISMISSED_KEY, notice.latest); } catch { /* no store: closed until the page reloads */ }
}

// Forget what this page closed (tests).
export function forgetDismissals(): void { dismissedOnThisPage = ""; }

function build(root: HTMLElement, notice: UpdateNotice, t: Translate, onClose: () => void): void {
  const doc = root.ownerDocument;
  const text = doc.createElement("span");
  text.className = "update-notice-text";
  text.textContent = t(notice.security ? "update.availableSecurity" : "update.available", { version: notice.latest });
  const link = doc.createElement("a");
  link.href = notice.notesUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = t("update.notes");
  const command = doc.createElement("span");
  command.className = "update-notice-command";
  const code = doc.createElement("code");
  code.textContent = notice.upgradeCommand;
  command.append(t("update.command"), " ", code);
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "update-notice-close";
  close.setAttribute("aria-label", t("update.dismiss"));
  close.title = t("update.dismiss");
  close.textContent = "×";
  close.addEventListener("click", onClose);
  root.replaceChildren(text, " ", link, " ", command, close);
}

// Draws or hides the banner for the latest /api/sessions answer. The markup is rebuilt only when
// the release or the language changes, so a poll does not take focus away from the close button.
export function render(root: HTMLElement, raw: unknown, t: Translate, store: Store | null, language: string): void {
  const notice = parseNotice(raw);
  if (!notice || !shouldShow(notice, store)) {
    root.hidden = true;
    root.replaceChildren();
    delete root.dataset.shown;
    return;
  }
  const key = `${notice.latest}|${notice.security}|${notice.upgradeCommand}|${language}`;
  if (root.dataset.shown !== key) {
    build(root, notice, t, () => {
      dismiss(notice, store);
      root.hidden = true;
      root.replaceChildren();
      delete root.dataset.shown;
    });
    root.dataset.shown = key;
  }
  root.hidden = false;
}
