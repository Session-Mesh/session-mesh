// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export interface DemoCatalogRow {
  readonly id: string;
  readonly title: string;
  readonly version: number;
}

export interface NamedDemoHistory {
  readonly demoId: string;
  readonly format: "mesh-scene-v0" | "mesh-scene-v1";
  readonly current: number;
  readonly versions: readonly number[];
}

export type DemoHistoryAction = Readonly<
  { kind: "preview"; version: number } | { kind: "restore"; version: number }
>;

const DEMO_ID = /^[0-9a-f]{32}$/;

// Displayed text comes from the app's catalogs. The app installs its translator
// once they are loaded; until then (and in Node checks without one) a key reads
// as itself. Text is always translated when it is produced, never at load.
export type Translator = (key: string, params?: Record<string, unknown>) => string;
const untranslated: Translator = (key) => key;
let translate: Translator = untranslated;
export function setTranslator(fn: Translator): void {
  translate = typeof fn === "function" ? fn : untranslated;
}

function validRow(value: unknown): value is DemoCatalogRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.title === "string" && Array.from(row.title).length <= 120
    && (row.id === "legacy" || (typeof row.id === "string" && DEMO_ID.test(row.id)))
    && Number.isSafeInteger(row.version) && (row.version as number) >= 0;
}

export function readCatalog(value: unknown): readonly DemoCatalogRow[] | null {
  if (!Array.isArray(value) || value.length > 8 || !value.every(validRow)) return null;
  const rows = value.map((row) => Object.freeze({ id: row.id, title: row.title, version: row.version }));
  if (new Set(rows.map((row) => row.id)).size !== rows.length) return null;
  return Object.freeze(rows);
}

export function readNamedHistory(value: unknown, expectedId: string): NamedDemoHistory | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !DEMO_ID.test(expectedId)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "current,demo_id,format,versions"
      || row.demo_id !== expectedId || (row.format !== "mesh-scene-v0" && row.format !== "mesh-scene-v1")
      || !Number.isSafeInteger(row.current) || (row.current as number) < 1
      || !Array.isArray(row.versions) || row.versions.length < 1 || row.versions.length > 64
      || !row.versions.every((version) => Number.isSafeInteger(version) && (version as number) >= 1)) return null;
  const versions = row.versions as number[];
  if (versions.some((version, index) => index > 0 && version <= versions[index - 1]!)
      || versions.at(-1) !== row.current) return null;
  return Object.freeze({ demoId: expectedId, format: row.format,
    current: row.current as number, versions: Object.freeze([...versions]) });
}

export function choiceLabel(row: DemoCatalogRow, rows: readonly DemoCatalogRow[]): string {
  const title = row.title || translate("demoCatalog.untitled");
  if (row.id === "legacy") return translate("demoCatalog.legacyChoice", { title });
  let prefixLength = 6;
  while (prefixLength < row.id.length
      && rows.some((other) => other.id !== row.id && other.id.startsWith(row.id.slice(0, prefixLength)))) {
    prefixLength += 1;
  }
  return `${title} · ${row.id.slice(0, prefixLength)}`;
}

export interface DemoChooser {
  readonly choose: (rows: readonly DemoCatalogRow[], selectedId: string | null,
    sessionLabel: string) => Promise<string | null>;
  readonly close: () => void;
}

export interface DemoHistoryDialog {
  readonly choose: (history: NamedDemoHistory, viewedVersion: number,
    demoLabel: string) => Promise<DemoHistoryAction | null>;
  readonly close: () => void;
}

export function createHistoryDialog(dialog: HTMLDialogElement): DemoHistoryDialog {
  const label = dialog.querySelector<HTMLElement>("[data-demo-history-label]");
  const choices = dialog.querySelector<HTMLElement>("[data-demo-history-choices]");
  const confirmation = dialog.querySelector<HTMLElement>("[data-demo-history-confirmation]");
  const confirmationText = dialog.querySelector<HTMLElement>("[data-demo-history-confirmation-text]");
  const confirmButton = dialog.querySelector<HTMLButtonElement>("[data-demo-history-confirm]");
  const backButton = dialog.querySelector<HTMLButtonElement>("[data-demo-history-back]");
  if (!label || !choices || !confirmation || !confirmationText || !confirmButton || !backButton) {
    throw new Error("Demo history elements missing");
  }
  let pending: ((action: DemoHistoryAction | null) => void) | null = null;
  let restoreFocus: HTMLElement | null = null;
  let history: NamedDemoHistory | null = null;
  let viewed = -1;
  let restoreVersion = -1;
  let restoreButton: HTMLButtonElement | null = null;

  const focusBack = (): void => {
    queueMicrotask(() => restoreFocus?.isConnected && restoreFocus.focus({ preventScroll: true }));
  };
  const settle = (action: DemoHistoryAction | null): void => {
    const resolve = pending;
    if (!resolve) return;
    pending = null;
    if (dialog.open) dialog.close();
    choices.replaceChildren();
    confirmation.hidden = true;
    resolve(action);
    focusBack();
  };
  dialog.addEventListener("close", () => settle(null));

  const showList = (): void => {
    if (!history) return;
    confirmation.hidden = true;
    choices.hidden = false;
    choices.replaceChildren(...[...history.versions].reverse().map((version) => {
      const row = dialog.ownerDocument.createElement("div");
      row.className = "demo-history-row";
      const description = dialog.ownerDocument.createElement("div");
      description.className = "demo-history-description";
      const name = dialog.ownerDocument.createElement("strong");
      name.textContent = translate("demoCatalog.history.revision", { version });
      description.append(name);
      if (version === history?.current) {
        const marker = dialog.ownerDocument.createElement("span");
        marker.className = "demo-history-marker";
        marker.textContent = translate("demoCatalog.history.current");
        description.append(marker);
      }
      if (version === viewed) {
        row.setAttribute("aria-current", "true");
        const marker = dialog.ownerDocument.createElement("span");
        marker.className = "demo-history-marker viewed";
        marker.textContent = translate("demoCatalog.history.shown");
        description.append(marker);
      }
      const actions = dialog.ownerDocument.createElement("div");
      actions.className = "demo-history-actions";
      const preview = dialog.ownerDocument.createElement("button");
      preview.type = "button";
      preview.className = "btn ghost";
      preview.textContent = version === viewed ? translate("demoCatalog.history.shown") : translate("common.show");
      preview.disabled = version === viewed;
      preview.addEventListener("click", () => settle({ kind: "preview", version }));
      actions.append(preview);
      if (version !== history?.current) {
        const restore = dialog.ownerDocument.createElement("button");
        restore.type = "button";
        restore.className = "btn";
        restore.textContent = translate("demoCatalog.history.restore");
        restore.addEventListener("click", () => {
          restoreVersion = version;
          restoreButton = restore;
          choices.hidden = true;
          confirmation.hidden = false;
          confirmationText.textContent = translate("demoCatalog.history.restoreConfirm", { version });
          confirmButton.focus({ preventScroll: true });
        });
        actions.append(restore);
      }
      row.append(description, actions);
      return row;
    }));
  };
  backButton.addEventListener("click", () => {
    showList();
    restoreButton?.focus({ preventScroll: true });
  });
  confirmButton.addEventListener("click", () => {
    if (history?.versions.includes(restoreVersion) && restoreVersion !== history.current) {
      settle({ kind: "restore", version: restoreVersion });
    }
  });

  return {
    choose(nextHistory, viewedVersion, demoLabel) {
      if (pending || dialog.open || !nextHistory.versions.includes(viewedVersion)) return Promise.resolve(null);
      history = nextHistory;
      viewed = viewedVersion;
      restoreVersion = -1;
      restoreButton = null;
      restoreFocus = dialog.ownerDocument.activeElement instanceof HTMLElement
        ? dialog.ownerDocument.activeElement : null;
      label.textContent = demoLabel;
      showList();
      dialog.showModal();
      (choices.querySelector<HTMLButtonElement>('[aria-current="true"] button:not(:disabled)')
        ?? choices.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?? dialog.querySelector<HTMLButtonElement>(".demo-history-cancel"))?.focus({ preventScroll: true });
      return new Promise<DemoHistoryAction | null>((resolve) => { pending = resolve; });
    },
    close() {
      if (dialog.open) dialog.close();
      else settle(null);
    },
  };
}

export function createChooser(dialog: HTMLDialogElement): DemoChooser {
  const session = dialog.querySelector<HTMLElement>("[data-demo-session]");
  const choices = dialog.querySelector<HTMLElement>("[data-demo-choices]");
  if (!session || !choices) throw new Error("Demo chooser elements missing");
  let pending: ((choice: string | null) => void) | null = null;

  const settle = (choice: string | null): void => {
    const resolve = pending;
    if (!resolve) return;
    pending = null;
    choices.replaceChildren();
    resolve(choice);
  };
  dialog.addEventListener("close", () => settle(null));

  return {
    choose(rows, selectedId, sessionLabel) {
      if (pending || dialog.open || rows.length < 2) return Promise.resolve(null);
      session.textContent = sessionLabel;
      choices.replaceChildren(...rows.map((row) => {
        const button = dialog.ownerDocument.createElement("button");
        button.type = "button";
        button.className = "btn ghost";
        button.dataset.demoId = row.id;
        button.textContent = choiceLabel(row, rows);
        if (row.id === selectedId) {
          button.setAttribute("aria-current", "true");
          button.title = translate("demoCatalog.chooser.currentTitle");
          const marker = dialog.ownerDocument.createElement("span");
          marker.className = "demo-current-marker";
          marker.textContent = translate("demoCatalog.chooser.currentMarker");
          button.append(marker);
        }
        button.addEventListener("click", () => {
          const choice = row.id;
          dialog.close();
          settle(choice);
        });
        return button;
      }));
      dialog.showModal();
      const selected = choices.querySelector<HTMLButtonElement>(`[data-demo-id="${selectedId ?? ""}"]`);
      (selected ?? choices.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
      return new Promise<string | null>((resolve) => { pending = resolve; });
    },
    close() {
      if (dialog.open) dialog.close();
      else settle(null);
    },
  };
}
