// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Pane-local presentation only. The app supplies data and keeps action authority.

export { replayPrefix } from "./terminal-replay.ts";
export { parsePtySize, sendsSize, sizePlan } from "./terminal-size-owner.ts";

// Displayed text comes from the app's catalogs. The app installs its translator
// once they are loaded; until then (and in Node checks without one) a key reads
// as itself. Text is always translated when it is produced, never at load.
export * from "./mailbox-panel.ts";
export * from "./config-panel.ts";
export * from "./backend-account-panel.ts";
export { createBackendAccountApi } from "./backend-account-api.ts";
export * from "./agent-mail-consent.ts";
export * from "./narrow-drawer.ts";
export { holdLineForTarget } from "./held-line.ts";
export { postInBatches } from "./restore-batches.ts";
export type Translator = (key: string, params?: Record<string, unknown>) => string;
const untranslated: Translator = (key) => key;
let translate: Translator = untranslated;
export function setTranslator(fn: Translator): void {
  translate = typeof fn === "function" ? fn : untranslated;
}

export type AgentState = "busy" | "waiting" | "shell" | "idle" | "unknown";

export interface HumanInputLease {
  readonly dirty: boolean;
  reconnect(): void;
  write(bytes: Uint8Array, complete?: boolean): boolean;
  atomic(bytes: Uint8Array): boolean;
}

// One browser tab owns one opaque client id. WebSocket ordering makes each
// successful H/D/H sequence visible to the PTY arbiter in that order. H is an
// advisory extension, though: an older relay or a transient control failure
// must never prevent the baseline D frame from reaching the terminal.
export function createHumanInputLease(ports: {
  readonly clientId: string;
  readonly control: (clientId: string, dirty: boolean) => void;
  readonly data: (bytes: Uint8Array) => void;
}): HumanInputLease {
  let dirty = false;
  const set = (next: boolean): void => {
    if (dirty === next) return;
    ports.control(ports.clientId, next);
    dirty = next;
  };
  const write = (bytes: Uint8Array, complete = false): boolean => {
    if (!bytes.byteLength) return false;
    if (!dirty) {
      try { set(true); } catch { /* H is optional; D remains the authority. */ }
    }
    let delivered = false;
    try {
      ports.data(bytes);
      delivered = true;
    } catch { /* An uncertain/failed D is reported to the caller below. */ }
    if (delivered && complete && dirty) {
      try { set(false); } catch { /* Keep dirty: reconnect must retry release. */ }
    }
    return delivered;
  };
  return {
    get dirty() { return dirty; },
    reconnect() {
      try { ports.control(ports.clientId, dirty); } catch { /* Socket setup must continue. */ }
    },
    write,
    atomic(bytes) { return write(bytes, true); },
  };
}

type PortfolioFactState = "observed" | "unavailable" | "not-collected" | "not-a-repository" | "malformed";
interface PortfolioMetadata { readonly source: string; readonly observedAt: string }
interface WorktreeFact {
  readonly path: string; readonly head: string; readonly branch: string;
  readonly detached: boolean; readonly bare: boolean;
}
interface WorktreeFacts extends PortfolioMetadata {
  readonly cwd: string; readonly state: PortfolioFactState; readonly facts: readonly WorktreeFact[];
}
export interface PortfolioProvenance extends PortfolioMetadata {
  readonly state: PortfolioFactState; readonly rows: readonly WorktreeFacts[];
}

// Received observation only: no clock sampling, network, capabilities or globals.
export function portfolioProvenance(value: unknown): PortfolioProvenance {
  const record = (input: unknown): Record<string, unknown> | null =>
    input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
  const metadata = (input: Record<string, unknown> | null): PortfolioMetadata => {
    const epoch = input?.observed_at;
    const date = typeof epoch === "number" && Number.isFinite(epoch) && epoch >= 0 ? new Date(epoch * 1000) : null;
    return { source: typeof input?.source === "string" && input.source ? input.source : translate("paneActions.provenance.unknownSource"),
      observedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : translate("paneActions.provenance.unknownTime") };
  };
  const input = record(value);
  const base = metadata(input);
  if (value == null || input?.state === "not-collected") return { ...base, state: "not-collected", rows: [] };
  if (input?.state === "unavailable") return { ...base, state: "unavailable", rows: [] };
  if (input?.state !== "observed" || !Array.isArray(input.directories)) return { ...base, state: "malformed", rows: [] };
  const rows = input.directories.map((raw): WorktreeFacts => {
    const row = record(raw);
    const validCwd = typeof row?.cwd === "string" && !!row.cwd;
    const rowBase = { ...metadata(row), cwd: validCwd ? row.cwd as string : translate("paneActions.provenance.unknownDirectory"), facts: [] };
    if (!row || !validCwd) return { ...rowBase, state: "malformed" };
    if (row.state === "unavailable" || row.state === "not-a-repository" || row.state === "not-collected") return { ...rowBase, state: row.state };
    if (row.state !== "observed" || !Array.isArray(row.worktrees)) return { ...rowBase, state: "malformed" };
    const facts: WorktreeFact[] = [];
    for (const rawFact of row.worktrees) {
      const fact = record(rawFact);
      if (!fact || typeof fact.path !== "string" || !fact.path || typeof fact.detached !== "boolean" || typeof fact.bare !== "boolean"
          || (fact.head != null && typeof fact.head !== "string") || (fact.branch != null && typeof fact.branch !== "string")) return { ...rowBase, state: "malformed" };
      facts.push({ path: fact.path, head: typeof fact.head === "string" && fact.head ? fact.head : translate("paneActions.provenance.unknownHead"),
        branch: typeof fact.branch === "string" && fact.branch ? fact.branch : translate("paneActions.provenance.unknownBranch"),
        detached: fact.detached, bare: fact.bare });
    }
    return { ...rowBase, state: "observed", facts };
  });
  return { ...base, state: "observed", rows };
}

export type ContextualDiffLineKind = "file-header" | "hunk-header" | "added" | "deleted" | "context";

export function contextualDiffSelector(listing: unknown, binding: { readonly name: string; readonly created: number; readonly cwd: string }): string | null {
  if (!listing || typeof listing !== "object") return null;
  const inventory = (listing as { mesh_sessions?: unknown }).mesh_sessions;
  if (!inventory || typeof inventory !== "object") return null;
  const { state, directories } = inventory as { state?: unknown; directories?: unknown };
  if (state !== "observed" || !Array.isArray(directories)) return null;
  for (const row of directories) {
    if (!row || typeof row !== "object" || row.cwd !== binding.cwd || !Array.isArray(row.sessions)) continue;
    const issuer = row.sessions[0];
    if (issuer?.name === binding.name && issuer.created === binding.created && typeof row.diff_selector === "string" && row.diff_selector) return row.diff_selector;
  }
  return null;
}

// Classification is presentation only: callers always render the original text.
export function contextualDiffLineKind(line: string): ContextualDiffLineKind {
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git ")) return "file-header";
  if (line.startsWith("@@ ")) return "hunk-header";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "deleted";
  return "context";
}

export function createContextualDiffLifetime(): {
  begin(): number | null;
  current(request: number): boolean;
  dispose(): void;
} {
  let generation = 0;
  let disposed = false;
  return {
    begin() { return disposed ? null : ++generation; },
    current(request) { return !disposed && request === generation; },
    dispose() { disposed = true; generation++; },
  };
}

export interface IdentitySnapshot {
  readonly kind: "terminal" | "document" | "board" | "demo" | "diff" | "unknown";
  readonly title: string;
  readonly origin: "local" | "external" | "unknown";
  readonly externalOrigin: string | null;
  readonly sessionLabel: string | null;
  readonly readOnly: boolean;
  readonly load: "loading" | "frame-loaded" | "connected" | "unavailable" | "unknown";
}

export function identityPresentation(snapshot: IdentitySnapshot): Readonly<Record<string, string>> {
  let origin = translate("paneActions.identity.originUnknown");
  if (snapshot.origin === "local") origin = translate("paneActions.identity.originLocal");
  if (snapshot.origin === "external" && snapshot.externalOrigin) {
    try {
      const url = new URL(snapshot.externalOrigin);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) origin = url.origin;
    } catch { /* Unknown provenance remains explicit. */ }
  }
  const states = {
    loading: () => translate("paneActions.identity.state.loading"),
    "frame-loaded": () => translate("paneActions.identity.state.frameLoaded"),
    connected: () => translate("paneActions.identity.state.connected"),
    unavailable: () => translate("paneActions.identity.state.unavailable"),
    unknown: () => translate("paneActions.identity.state.unknown"),
  };
  const kinds = {
    terminal: () => translate("paneActions.identity.kind.terminal"),
    document: () => translate("paneActions.identity.kind.document"),
    board: () => translate("paneActions.identity.kind.board"),
    demo: () => translate("paneActions.identity.kind.demo"),
    diff: () => translate("paneActions.identity.kind.diff"),
    unknown: () => translate("paneActions.identity.kind.unknown"),
  };
  const readOnly = (snapshot.kind === "diff" || snapshot.kind === "demo") && snapshot.readOnly;
  return {
    kind: kinds[snapshot.kind](),
    title: snapshot.title,
    origin: translate("paneActions.identity.origin", { origin }),
    session: translate("paneActions.identity.session",
      { session: snapshot.sessionLabel || translate("paneActions.identity.sessionUnknown") }),
    rights: readOnly ? translate("paneActions.identity.readOnly") : translate("paneActions.identity.rightsHidden"),
    state: states[snapshot.load](),
  };
}

export interface HeaderSnapshot {
  readonly name: string;
  readonly cwd: string;
  readonly terminal: boolean;
  readonly agentStatus: string | null;
  readonly unread: boolean;
  readonly boardModified: boolean;
}

export interface HeaderCallbacks {
  readonly rename: () => void;
}

export interface HeaderController {
  readonly update: (snapshot: HeaderSnapshot) => void;
  readonly setConnection: (text: string, bad: boolean) => void;
}

export function agentState(status: string | null): AgentState {
  switch (status) {
    case "busy": case "waiting": case "shell": case "idle": return status;
    default: return "unknown";
  }
}

export function createHeader(root: HTMLElement, callbacks: HeaderCallbacks): HeaderController {
  // Query only the injected pane. No Mesh, terminal, network or document singleton.
  const required = <T extends Element>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Pane header element missing: ${selector}`);
    return element;
  };
  const name = required<HTMLElement>(".p-name");
  const fullName = required<HTMLElement>(".p-full-name");
  const disclosure = required<HTMLElement>(".p-name-disclosure summary");
  const cwd = required<HTMLElement>(".p-cwd");
  const agent = required<HTMLElement>(".p-agent");
  const unread = required<HTMLElement>(".p-unread");
  const boardHint = required<HTMLElement>(".p-board-hint");
  const board = required<HTMLButtonElement>('[data-act="board"]');
  const connection = required<HTMLElement>(".conn");
  name.addEventListener("dblclick", () => callbacks.rename());

  return {
    update(snapshot) {
      // An inventory/header refresh must not replace an active inline rename.
      if (!name.querySelector("input.rename")) name.textContent = snapshot.name;
      fullName.textContent = snapshot.name;
      disclosure.setAttribute("aria-label", translate("paneActions.header.fullName", { name: snapshot.name }));
      cwd.textContent = snapshot.cwd;
      name.title = snapshot.terminal ? translate("paneActions.header.renameHint", { name: snapshot.name }) : snapshot.name;
      const state = agentState(snapshot.agentStatus);
      agent.hidden = !snapshot.terminal;
      agent.dataset.state = state;
      agent.textContent = translate("paneActions.header.agent", { state: translate(`paneActions.agent.${state}`) });
      agent.title = agent.textContent;
      unread.hidden = !(snapshot.terminal && snapshot.unread);
      boardHint.hidden = !(snapshot.terminal && snapshot.boardModified);
      const modified = snapshot.terminal && snapshot.boardModified;
      board.classList.toggle("board-modified", modified);
      board.setAttribute("aria-label", modified ? translate("paneActions.header.openBoardModified") : translate("paneActions.header.openBoard"));
    },
    setConnection(text, bad) {
      connection.textContent = text
        ? translate("paneActions.header.connection", { state: text === "●" ? translate("paneActions.header.connected") : text })
        : "";
      connection.title = connection.textContent;
      connection.classList.toggle("bad", bad);
      connection.hidden = !text;
    },
  };
}

export type PaneKind = "mesh" | "web" | "board" | "external" | "history" | "empty";
export type ActionId = "file" | "compose" | "browse" | "redraw" | "folder" | "raw" | "demo" | "stop" | "close" | "reload" | "newtab" | "watch";
// Action identifiers and their presentation keys are a closed, code-owned
// vocabulary.  A future extension may request one of these actions, but it
// cannot provide executable behavior or invent an identifier/message key.
export type ActionMessageKey =
  | "action.attach" | "action.compose" | "action.browse" | "action.redraw" | "action.demo"
  | "action.folder" | "action.raw" | "action.stop" | "action.close"
  | "action.reload" | "action.open-external" | "action.watch-start" | "action.watch-stop";
export interface ActionDefinition {
  readonly id: ActionId;
  readonly messageKey: ActionMessageKey;
  readonly label: string;
  readonly danger: boolean;
}
// `label` is read at use, so it follows the translator installed at that time.
const declareAction = (id: ActionId, messageKey: ActionMessageKey, danger: boolean): ActionDefinition => Object.freeze({
  id, messageKey, danger,
  get label() { return translate(`paneActions.action.${id}`); },
});
const ACTION_CATALOG: readonly ActionDefinition[] = Object.freeze([
  declareAction("file", "action.attach", false),
  declareAction("compose", "action.compose", false),
  declareAction("browse", "action.browse", false),
  declareAction("redraw", "action.redraw", false),
  declareAction("demo", "action.demo", false),
  declareAction("folder", "action.folder", false),
  declareAction("raw", "action.raw", false),
  declareAction("stop", "action.stop", true),
  declareAction("close", "action.close", false),
  declareAction("reload", "action.reload", false),
  declareAction("newtab", "action.open-external", false),
  declareAction("watch", "action.watch-start", false),
]);
const ACTIONS_BY_ID = new Map<ActionId, ActionDefinition>(ACTION_CATALOG.map((action) => [action.id, action]));
const ACTION_MESSAGE_KEYS: readonly ActionMessageKey[] = Object.freeze([
  ...ACTION_CATALOG.map((action) => action.messageKey), "action.watch-stop",
]);
const ACTION_MESSAGE_KEY_SET = new Set<string>(ACTION_MESSAGE_KEYS);
if (ACTIONS_BY_ID.size !== ACTION_CATALOG.length) throw new Error("duplicate Mesh action identifier");
if (ACTION_MESSAGE_KEY_SET.size !== ACTION_MESSAGE_KEYS.length) throw new Error("duplicate Mesh action message key");
export function actionCatalog(): readonly ActionDefinition[] { return ACTION_CATALOG; }
export function actionDefinition(value: unknown): ActionDefinition | null {
  return typeof value === "string" ? ACTIONS_BY_ID.get(value as ActionId) ?? null : null;
}
export function actionMessageKey(value: unknown): ActionMessageKey | null {
  return typeof value === "string" && ACTION_MESSAGE_KEY_SET.has(value) ? value as ActionMessageKey : null;
}

// This is a catalog, not a permission system.  It gives future extension
// manifests a closed vocabulary, while every non-empty request remains
// unavailable until a separately reviewed host bridge exists.
export type ExtensionSurface = "demo" | "mod";
export type CapabilityId = "session.summary.read" | "portfolio.read" | "roadmap.read"
  | "signals.subscribe" | "skills.usage.read" | "network.fetch";
export interface CapabilityDefinition {
  readonly id: CapabilityId;
  readonly surfaces: readonly ExtensionSurface[];
  readonly state: "reserved";
}
const MOD_SURFACES: readonly ExtensionSurface[] = Object.freeze(["mod"]);
const CAPABILITY_CATALOG: readonly CapabilityDefinition[] = Object.freeze([
  Object.freeze({ id: "session.summary.read", surfaces: MOD_SURFACES, state: "reserved" }),
  Object.freeze({ id: "portfolio.read", surfaces: MOD_SURFACES, state: "reserved" }),
  Object.freeze({ id: "roadmap.read", surfaces: MOD_SURFACES, state: "reserved" }),
  Object.freeze({ id: "signals.subscribe", surfaces: MOD_SURFACES, state: "reserved" }),
  Object.freeze({ id: "skills.usage.read", surfaces: MOD_SURFACES, state: "reserved" }),
  Object.freeze({ id: "network.fetch", surfaces: MOD_SURFACES, state: "reserved" }),
]);
const CAPABILITIES_BY_ID = new Map<CapabilityId, CapabilityDefinition>(CAPABILITY_CATALOG.map((capability) => [capability.id, capability]));
if (CAPABILITIES_BY_ID.size !== CAPABILITY_CATALOG.length) throw new Error("duplicate Mesh capability identifier");
export function capabilityCatalog(): readonly CapabilityDefinition[] { return CAPABILITY_CATALOG; }
export function capabilityDefinition(value: unknown): CapabilityDefinition | null {
  return typeof value === "string" ? CAPABILITIES_BY_ID.get(value as CapabilityId) ?? null : null;
}
export type CapabilityRequestResult =
  | { readonly accepted: true; readonly capabilities: readonly CapabilityDefinition[] }
  | { readonly accepted: false; readonly reason: "malformed" | "duplicate" | "unknown" | "reserved" | "wrong-surface" };
export function validateCapabilityRequest(value: unknown): CapabilityRequestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { accepted: false, reason: "malformed" };
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys.join(",") !== "capabilities,surface,v" || record.v !== 1
    || (record.surface !== "demo" && record.surface !== "mod") || !Array.isArray(record.capabilities)
    || record.capabilities.length > 16 || record.capabilities.some((capability) => typeof capability !== "string")) {
    return { accepted: false, reason: "malformed" };
  }
  const requested = record.capabilities as readonly string[];
  if (new Set(requested).size !== requested.length) return { accepted: false, reason: "duplicate" };
  const definitions = requested.map(capabilityDefinition);
  if (definitions.some((definition) => definition === null)) return { accepted: false, reason: "unknown" };
  const known = definitions as readonly CapabilityDefinition[];
  if (known.some((definition) => !definition.surfaces.includes(record.surface as ExtensionSurface))) {
    return { accepted: false, reason: "wrong-surface" };
  }
  if (known.length) return { accepted: false, reason: "reserved" };
  return { accepted: true, capabilities: Object.freeze([]) };
}

// A decoded v1 mod identity.  This is deliberately not a loader or an
// approval: the only representable capability list is empty.  The OCaml
// decoder owns byte-level JSON validation (including duplicate member
// rejection); this projection is for already-decoded client observations.
export interface ModDescriptorV1 {
  readonly v: 1;
  readonly kind: "mod";
  readonly modId: string;
  readonly codeDigest: string;
  readonly capabilities: readonly CapabilityDefinition[];
}
const MOD_DESCRIPTOR_KEYS = "capabilities,code_digest,kind,mod_id,v";
const MOD_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const CODE_DIGEST_RE = /^[0-9a-f]{64}$/;
export function modDescriptorV1(value: unknown): ModDescriptorV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== MOD_DESCRIPTOR_KEYS || record.v !== 1 || record.kind !== "mod"
    || typeof record.mod_id !== "string" || !MOD_ID_RE.test(record.mod_id)
    || typeof record.code_digest !== "string" || !CODE_DIGEST_RE.test(record.code_digest)) return null;
  const capabilities = validateCapabilityRequest({ v: 1, surface: "mod", capabilities: record.capabilities });
  if (!capabilities.accepted || capabilities.capabilities.length !== 0) return null;
  return Object.freeze({ v: 1, kind: "mod", modId: record.mod_id, codeDigest: record.code_digest,
    capabilities: Object.freeze([]) });
}
export function sameModCodeRevision(left: ModDescriptorV1, right: ModDescriptorV1): boolean {
  return left.modId === right.modId && left.codeDigest === right.codeDigest;
}
export interface Applicability {
  readonly kind: PaneKind;
  readonly multiple: boolean;
  readonly rawCodex: boolean;
  readonly fileWeb: boolean;
  readonly watching: boolean;
}
export interface MenuAction extends ActionDefinition {}
export function availableActions(view: Applicability): readonly MenuAction[] {
  const entries: MenuAction[] = [];
  const add = (id: ActionId, override?: Pick<MenuAction, "messageKey" | "label">): void => {
    const definition = actionDefinition(id);
    if (!definition) throw new Error(`unknown Mesh action: ${id}`);
    const entry = Object.freeze(override ? { ...definition, ...override } : definition);
    if (!actionMessageKey(entry.messageKey)) throw new Error(`unknown Mesh action message key: ${entry.messageKey}`);
    entries.push(entry);
  };
  if (view.kind === "mesh") {
    add("file"); add("compose"); add("browse"); add("redraw"); add("demo"); add("folder");
    if (view.rawCodex) add("raw");
    add("stop");
  } else if (view.kind === "web" || view.kind === "board") {
    add("reload"); add("newtab");
    if (view.kind === "web" && view.fileWeb) add("watch", view.watching
      ? { messageKey: "action.watch-stop", label: translate("paneActions.action.watchStop") }
      : undefined);
  }
  if (view.multiple) add("close");
  return entries;
}

export interface Identity { readonly id: string; readonly name: string; readonly created: number | null }
export interface PaneEvidence {
  readonly pane: object; readonly id: string | null; readonly name: string | null;
  readonly sessionId: string | null;
  readonly displayName: string; readonly created: number | null; readonly view: number;
  readonly kind: PaneKind; readonly available: boolean;
}
export interface CapturedTarget extends PaneEvidence { readonly activeSensitive: boolean }
export interface TargetRegistry {
  readonly observePane: (evidence: PaneEvidence) => void;
  readonly setActive: (pane: object | null) => void;
  readonly invalidatePane: (pane: object) => void;
  readonly capture: (pane: object, activeSensitive?: boolean) => CapturedTarget | null;
  readonly valid: (target: CapturedTarget) => boolean;
  readonly release: (target: CapturedTarget) => void;
  readonly applyInventory: (issue: number, identities: readonly Identity[]) => boolean;
  readonly identity: (id: string) => Identity | null;
}
export function createTargetRegistry(): TargetRegistry {
  const panes = new Map<object, PaneEvidence>();
  const tokens = new Map<CapturedTarget, boolean>();
  let active: object | null = null;
  let applied = 0;
  let inventory = new Map<string, Identity>();
  const equal = (a: PaneEvidence, b: PaneEvidence): boolean => a.pane === b.pane && a.id === b.id
    && a.name === b.name && a.sessionId === b.sessionId && a.created === b.created && a.view === b.view && a.kind === b.kind && b.available;
  const valid = (target: CapturedTarget): boolean => {
    if (tokens.get(target) !== true) return false;
    const current = panes.get(target.pane);
    if (!current || !equal(target, current) || (target.activeSensitive && active !== target.pane)) {
      tokens.set(target, false); return false;
    }
    return true;
  };
  return {
    observePane(evidence) {
      if (evidence.available) panes.set(evidence.pane, Object.freeze({ ...evidence }));
      else panes.delete(evidence.pane);
      for (const target of tokens.keys()) if (target.pane === evidence.pane) valid(target);
    },
    setActive(pane) {
      active = pane;
      for (const target of tokens.keys()) if (target.activeSensitive && target.pane !== pane) tokens.set(target, false);
    },
    invalidatePane(pane) {
      for (const target of tokens.keys()) if (target.pane === pane) tokens.set(target, false);
    },
    capture(pane, activeSensitive = false) {
      const evidence = panes.get(pane);
      if (!evidence?.available || (activeSensitive && active !== pane)) return null;
      if ((evidence.kind === "mesh" || evidence.kind === "board") && applied > 0) {
        const observed = evidence.sessionId ? inventory.get(evidence.sessionId) : null;
        if (!observed || observed.name !== evidence.name || observed.created !== evidence.created) return null;
      }
      const target = Object.freeze({ ...evidence, activeSensitive });
      tokens.set(target, true); return target;
    },
    valid,
    release(target) { tokens.delete(target); },
    applyInventory(issue, identities) {
      if (!Number.isSafeInteger(issue) || issue <= applied) return false;
      if (identities.some((identity) => typeof identity.id !== "string" || !identity.id
        || typeof identity.name !== "string" || !identity.name
        || (identity.created !== null && !Number.isFinite(identity.created)))) return false;
      const next = new Map(identities.map((identity) => [identity.id, Object.freeze({ ...identity })]));
      if (next.size !== identities.length) return false;
      inventory = next; applied = issue;
      for (const target of tokens.keys()) {
        if (target.kind !== "mesh" && target.kind !== "board") continue;
        const current = target.sessionId ? inventory.get(target.sessionId) : null;
        if (!current || current.name !== target.name || current.created !== target.created) tokens.set(target, false);
      }
      return true;
    },
    identity(id) { return inventory.get(id) ?? null; },
  };
}

export interface StopPorts {
  readonly valid: (target: CapturedTarget) => boolean;
  readonly confirm: (target: CapturedTarget) => boolean;
  readonly dispatch: (target: CapturedTarget) => void | Promise<void>;
}
export type StopOutcome = "refused" | "cancelled" | "dispatched";
export function createStopGuard(ports: StopPorts): (target: CapturedTarget) => Promise<StopOutcome> {
  // The real endpoint is name-based. Two panes (or a replaced incarnation)
  // must not launch concurrent confirmation/dispatch for that same name.
  const pending = new Set<string>();
  return async (target) => {
    if (target.kind !== "mesh" || !target.name || pending.has(target.name) || !ports.valid(target)) return "refused";
    const key = target.name;
    pending.add(key);
    try {
      if (!ports.valid(target)) return "refused";
      if (!ports.confirm(target)) return "cancelled";
      // Native confirmation can run a nested browser event loop. Recheck now.
      if (!ports.valid(target)) return "refused";
      await ports.dispatch(target);
      return "dispatched";
    } finally { pending.delete(key); }
  };
}

export interface PasteSocket { send(bytes: Uint8Array): void }
export interface PasteConnection {
  readonly ws: PasteSocket | null;
  readonly closed: boolean; readonly ended?: boolean; readonly initializing: boolean;
}
export interface PasteBinding {
  readonly pane: object; readonly target: CapturedTarget;
  readonly connection: PasteConnection; readonly socket: PasteSocket;
}
export type PasteResultKind = "refused" | "paste" | "submitted" | "uncertain";
export interface PasteResult {
  readonly kind: PasteResultKind;
  readonly requestedBytes: number; readonly frames: number; readonly wireBytes: number;
  readonly unknownAttempt: boolean;
  readonly reason: "guard" | "incomplete" | "send" | "paste" | "schedule" | "cancel" | null;
}
export interface PastePorts {
  readonly valid: (target: CapturedTarget) => boolean;
  readonly connection: (pane: object) => PasteConnection | null;
  readonly open: (socket: PasteSocket) => boolean;
  readonly paste: (pane: object, text: string) => void;
  readonly encode: (text: string) => Uint8Array;
  readonly send?: (pane: object, socket: PasteSocket, bytes: Uint8Array, complete: boolean) => boolean;
  readonly schedule: (callback: () => void) => void;
}
export interface PasteDelivery {
  readonly capture: (pane: object, target: CapturedTarget) => PasteBinding | null;
  readonly onData: (pane: object, frame: string, ordinary: () => void) => void;
  readonly deliver: (binding: PasteBinding, text: string, enter: boolean,
    settle: (result: PasteResult) => void) => { readonly cancel: () => void };
}
export function createPasteDelivery(ports: PastePorts): PasteDelivery {
  type Attempt = { binding: PasteBinding; frames: number; wireBytes: number; joined: string;
    stopped: boolean; unknown: boolean; reason: PasteResult["reason"] };
  let current: Attempt | null = null;
  const valid = (binding: PasteBinding): boolean => ports.valid(binding.target)
    && ports.connection(binding.pane) === binding.connection
    && binding.connection.ws === binding.socket
    && !binding.connection.closed && !binding.connection.ended && !binding.connection.initializing
    && ports.open(binding.socket);
  const result = (attempt: Attempt, requestedBytes: number, kind: PasteResultKind): PasteResult => ({
    kind, requestedBytes, frames: attempt.frames, wireBytes: attempt.wireBytes,
    unknownAttempt: attempt.unknown, reason: attempt.reason,
  });
  const send = (attempt: Attempt, frame: string): void => {
    if (attempt.stopped) return;
    if (!valid(attempt.binding)) { attempt.stopped = true; attempt.reason = "guard"; return; }
    const bytes = ports.encode(frame);
    try {
      const accepted = ports.send
        ? ports.send(attempt.binding.pane, attempt.binding.socket, bytes, frame === "\r")
        : (attempt.binding.socket.send(bytes), true);
      if (!accepted) throw new Error("send refused");
    }
    catch { attempt.stopped = true; attempt.unknown = true; attempt.reason = "send"; return; }
    attempt.frames++; attempt.wireBytes += bytes.byteLength; attempt.joined += frame;
  };
  return {
    capture(pane, target) {
      const connection = ports.connection(pane), socket = connection?.ws;
      if (!connection || !socket) return null;
      const binding = Object.freeze({ pane, target, connection, socket });
      return valid(binding) ? binding : null;
    },
    onData(pane, frame, ordinary) {
      const attempt = current;
      if (attempt?.binding.pane === pane) send(attempt, frame);
      else ordinary();
    },
    deliver(binding, text, enter, settle) {
      const requestedBytes = ports.encode(text).byteLength;
      const attempt: Attempt = { binding, frames: 0, wireBytes: 0, joined: "",
        stopped: false, unknown: false, reason: null };
      let settled = false;
      const finish = (kind: PasteResultKind): void => {
        if (settled) return;
        settled = true; settle(result(attempt, requestedBytes, kind));
      };
      const operation = { cancel: (): void => {
        if (settled) return;
        attempt.stopped = true; attempt.reason = "cancel";
        finish(attempt.frames || attempt.unknown ? "uncertain" : "refused");
      } };
      if (!valid(binding)) { attempt.reason = "guard"; finish("refused"); return operation; }
      if (!text) {
        if (!enter) { attempt.reason = "incomplete"; finish("refused"); return operation; }
        send(attempt, "\r");
        finish(attempt.stopped ? (attempt.unknown ? "uncertain" : "refused") : "submitted");
        return operation;
      }
      const previous = current;
      current = attempt;
      try { ports.paste(binding.pane, text); }
      catch { attempt.stopped = true; attempt.unknown = true; attempt.reason = "paste"; }
      finally { current = previous; }
      // xterm may normalize line endings and surround the payload with bracketed
      // paste frames. Do not accept a framing-only or truncated synchronous paste.
      const normalize = (value: string): string => value.replace(/\r\n|\n/g, "\r");
      if (!attempt.stopped && (!attempt.frames || !normalize(attempt.joined).includes(normalize(text)))) {
        attempt.stopped = true; attempt.reason = "incomplete";
      }
      if (attempt.stopped) {
        finish(attempt.frames || attempt.unknown ? "uncertain" : "refused");
        return operation;
      }
      if (!enter) { finish("paste"); return operation; }
      try {
        ports.schedule(() => {
          if (settled) return;
          send(attempt, "\r");
          finish(attempt.stopped ? "uncertain" : "submitted");
        });
      } catch { attempt.reason = "schedule"; finish("uncertain"); }
      return operation;
    },
  };
}

// A composer opening owns one destination and one text revision. Closing it
// retires that destination; selecting another pane does not. The browser owns
// the textarea and transport, while this small domain gate prevents stale
// asynchronous work from acquiring either one.
export interface ComposeOwner {
  readonly target: CapturedTarget;
  readonly binding: PasteBinding;
  readonly revision: number;
  readonly open: boolean;
  readonly pending: boolean;
  readonly change: () => boolean;
  readonly begin: () => number | null;
  readonly settle: (revision: number) => boolean;
  readonly acceptsUpload: (revision: number) => boolean;
  readonly close: () => void;
}
export function createComposeOwner(target: CapturedTarget, binding: PasteBinding): ComposeOwner {
  let revision = 0, open = true, pending = false;
  return {
    target, binding,
    get revision() { return revision; },
    get open() { return open; },
    get pending() { return pending; },
    change() { if (!open || pending) return false; revision++; return true; },
    begin() { if (!open || pending) return null; pending = true; return revision; },
    settle(original) {
      if (!pending) return false;
      pending = false;
      return open && original === revision;
    },
    acceptsUpload(original) { return open && !pending && original === revision; },
    close() { open = false; },
  };
}

export interface ChooserToken {
  readonly source: object;
  readonly destination: object;
  readonly serial: number;
}
export interface ChooserGate {
  readonly pending: ChooserToken | null;
  readonly acquire: (source: object, destination: object) => ChooserToken | null;
  readonly owns: (token: ChooserToken) => boolean;
  readonly settle: (token: ChooserToken) => boolean;
  readonly reset: (token: ChooserToken) => boolean;
}
export function createChooserGate(): ChooserGate {
  let pending: ChooserToken | null = null, serial = 0;
  const settle = (token: ChooserToken): boolean => {
    if (pending !== token) return false;
    pending = null; return true;
  };
  return {
    get pending() { return pending; },
    acquire(source, destination) {
      if (pending) return null;
      const token = Object.freeze({ source, destination, serial: ++serial });
      pending = token; return token;
    },
    owns(token) { return pending === token && token.source === pending.source; },
    settle,
    reset: settle,
  };
}

type SessionActionRequest = Readonly<{
  id: string;
  action: "create" | "restart" | "switch_account";
  state: "pending" | "claimed";
  preset: string | null;
  model: string | null;
  lease_expires_at?: number | null;
  source: Readonly<{ id: string }>;
  // switch_account: the account ids, and their labels as the server knows them
  account?: string | null;
  account_label?: string | null;
  from_account?: string | null;
  from_label?: string | null;
}>;

// The owner reads the label of the "New session" form, not an internal preset id.
const PRESET_LABEL_KEYS: Readonly<Record<string, string>> = Object.freeze({ "codex-yolo": "new.codexYolo" });

function presetLabel(preset: string | null): string {
  if (preset === null) return translate("paneActions.sessionRequest.defaultPreset");
  const key = Object.hasOwn(PRESET_LABEL_KEYS, preset) ? PRESET_LABEL_KEYS[preset] : undefined;
  return key ? translate(key) : preset;
}

/** An account as the switch dialog names it: its label, and its id when the label differs. */
function accountName(id: string, label: string | null | undefined): string {
  return typeof label === "string" && label && label !== id ? `${label} (${id})` : id;
}

function describeSessionRequest(request: SessionActionRequest): string {
  const params = { agent: request.source.id, model: request.model, preset: presetLabel(request.preset) };
  if (request.action === "switch_account") {
    // The owner approves sending the whole conversation to the other account's provider: the text says so.
    return translate("paneActions.sessionRequest.switchAccount", { agent: request.source.id,
      from: accountName(request.from_account as string, request.from_label),
      to: accountName(request.account as string, request.account_label) });
  }
  if (request.action === "restart") {
    return request.model ? translate("paneActions.sessionRequest.restartWithModel", params)
      : translate("paneActions.sessionRequest.restart", params);
  }
  return request.model ? translate("paneActions.sessionRequest.createWithModel", params)
    : translate("paneActions.sessionRequest.create", params);
}

type SessionRequestClaim = Readonly<{kind: "claimed"; claimNonce: string}>;
type SessionRequestBusy = Readonly<{kind: "busy"; leaseExpiresAt: number | null}>;

/** One owner dialog per server lease, with retry only after transport failure. */
export function createSessionRequestGate(ports: Readonly<{
  claim: (id: string, claimNonce?: string) => Promise<SessionRequestClaim | SessionRequestBusy | "stale" | "retry">;
  confirm: (message: string) => boolean;
  decide: (id: string, approve: boolean, claimNonce: string) => Promise<"settled" | "stale" | "retry">;
  notify: (message: string) => void;
  now?: () => number;
  jitterMs?: (id: string) => number;
}>) {
  const handled = new Set<string>();
  const inFlight = new Set<string>();
  const claims = new Map<string, string>();
  const decisions = new Map<string, boolean>();
  const retryAfter = new Map<string, number>();
  const notifiedLease = new Map<string, number>();
  const now = ports.now ?? Date.now;
  const jitterMs = ports.jitterMs ?? ((id: string) => 50 + ([...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 201));
  const boundedRetryAt = (id: string, epochMs: number | null): number => {
    const current = now();
    if (epochMs === null) return current + 1000;
    return Math.max(current + 250, Math.min(epochMs + jitterMs(id), current + 60_000));
  };
  const valid = (value: unknown): value is SessionActionRequest => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const request = value as Partial<SessionActionRequest>;
    const switchNames = request.action !== "switch_account"
      || (typeof request.account === "string" && request.account.length > 0
        && typeof request.from_account === "string" && request.from_account.length > 0);
    return typeof request.id === "string" && request.id.length > 0
      && (request.action === "create" || request.action === "restart" || request.action === "switch_account")
      && switchNames
      && (request.state === "pending" || request.state === "claimed") && !!request.source
      && typeof request.source.id === "string";
  };
  return {
    async consider(values: unknown): Promise<void> {
      if (!Array.isArray(values)) return;
      const visible = new Set(values.flatMap(value => value && typeof value === "object"
        && typeof (value as {id?: unknown}).id === "string" ? [(value as {id: string}).id] : []));
      for (const id of retryAfter.keys()) if (!visible.has(id)) retryAfter.delete(id);
      for (const id of notifiedLease.keys()) if (!visible.has(id)) notifiedLease.delete(id);
      for (const value of values) {
        if (!valid(value) || handled.has(value.id) || inFlight.has(value.id)) continue;
        const leaseHint = typeof value.lease_expires_at === "number" && Number.isFinite(value.lease_expires_at)
          ? value.lease_expires_at * 1000 : null;
        const waitUntil = retryAfter.get(value.id) ?? (value.state === "claimed" && leaseHint !== null
          ? boundedRetryAt(value.id, leaseHint) : 0);
        if (waitUntil > now()) {
          retryAfter.set(value.id, waitUntil);
          if (notifiedLease.get(value.id) !== waitUntil) {
            notifiedLease.set(value.id, waitUntil);
            ports.notify(translate("paneActions.sessionRequest.leaseWait"));
          }
          continue;
        }
        retryAfter.delete(value.id);
        inFlight.add(value.id);
        const claim = await ports.claim(value.id, claims.get(value.id));
        if (claim === "stale") {
          handled.add(value.id);
          ports.notify(translate("paneActions.sessionRequest.stale"));
          inFlight.delete(value.id); continue;
        }
        if (typeof claim === "object" && claim.kind === "busy") {
          const expiry = boundedRetryAt(value.id, claim.leaseExpiresAt === null
            ? null : claim.leaseExpiresAt * 1000);
          retryAfter.set(value.id, expiry);
          if (notifiedLease.get(value.id) !== expiry) {
            notifiedLease.set(value.id, expiry);
            ports.notify(translate("paneActions.sessionRequest.leaseWait"));
          }
          inFlight.delete(value.id); continue;
        }
        if (claim === "retry") { inFlight.delete(value.id); continue; }
        retryAfter.delete(value.id); notifiedLease.delete(value.id);
        claims.set(value.id, claim.claimNonce);
        const approve = decisions.has(value.id) ? decisions.get(value.id) as boolean
          : ports.confirm(translate("paneActions.sessionRequest.confirm", { description: describeSessionRequest(value) }));
        decisions.set(value.id, approve);
        const outcome = await ports.decide(value.id, approve, claim.claimNonce);
        if (outcome === "settled") handled.add(value.id);
        if (outcome === "stale") {
          handled.add(value.id);
          ports.notify(translate("paneActions.sessionRequest.decidedElsewhere"));
        }
        if (outcome !== "retry") { claims.delete(value.id); decisions.delete(value.id); }
        inFlight.delete(value.id);
      }
    },
  };
}

export type UploadItem = Readonly<{
  name: string; status: "pending" | "uploaded" | "error" | "skipped";
  path: string | null; error: string | null;
}>;
export interface UploadBatch {
  readonly items: readonly UploadItem[];
  readonly abandoned: boolean;
  readonly complete: boolean;
  readonly next: () => number | null;
  readonly finish: (index: number, outcome: { path: string } | { error: string }) => boolean;
  readonly abandon: () => boolean;
}
export function createUploadBatch(names: readonly string[]): UploadBatch {
  let items: readonly UploadItem[] = Object.freeze(names.map((name) => Object.freeze({
    name, status: "pending", path: null, error: null,
  })));
  let cursor = 0, inFlight: number | null = null, abandoned = false;
  return {
    get items() { return items; },
    get abandoned() { return abandoned; },
    get complete() { return inFlight === null && (abandoned || cursor === items.length); },
    next() {
      if (abandoned || inFlight !== null || cursor >= items.length) return null;
      inFlight = cursor++;
      return inFlight;
    },
    finish(index, outcome) {
      if (inFlight !== index || index < 0 || index >= items.length) return false;
      const path = "path" in outcome ? outcome.path : null;
      const error = "error" in outcome ? outcome.error : null;
      if ((path === null) === (error === null) || path === "" || error === "") return false;
      items = Object.freeze(items.map((item, at) => at === index ? Object.freeze({
        name: item.name, status: path === null ? "error" : "uploaded", path, error,
      }) : item));
      inFlight = null;
      return true;
    },
    abandon() {
      if (abandoned || (inFlight === null && cursor === items.length)) return false;
      abandoned = true;
      items = Object.freeze(items.map((item, at) => at >= cursor && item.status === "pending"
        ? Object.freeze({ ...item, status: "skipped" }) : item));
      return true;
    },
  };
}

export interface MenuPorts {
  readonly activate: () => void;
  readonly actions: () => readonly MenuAction[];
  readonly capture: () => CapturedTarget | null;
  readonly valid: (target: CapturedTarget) => boolean;
  readonly release: (target: CapturedTarget) => void;
  readonly run: (action: ActionId, target: CapturedTarget) => void | Promise<void>;
  readonly hold: (held: boolean) => void;
  readonly canFocus: (element: HTMLElement) => boolean;
  readonly fallbackFocus: () => void;
  readonly reportError: (error: unknown) => void;
}
export interface MenuController {
  readonly refresh: () => void;
  readonly close: (reason?: "escape" | "outside" | "tab" | "invalidate") => void;
  readonly dispose: () => void;
}
let nextMenuId = 0;
type MenuCloseReason = "escape" | "outside" | "tab" | "invalidate";

/** Where the focus goes once the menu is hidden: see createMenu. */
function focusAfterMenuHide(trigger: HTMLButtonElement, ports: MenuPorts, ownerDocument: Document,
  focus: { menuHeldFocus: boolean; triggerWasFocusTarget: boolean }, reason: MenuCloseReason): void {
  if (focus.menuHeldFocus) {
    // A hidden focused row remains document.activeElement in Chromium. Tab
    // starts at the trigger; other exits must not strand keyboard focus.
    // Capture eligibility before hiding: getClientRects can be transiently
    // empty while Chromium removes the focused menu row from layout.
    if (focus.triggerWasFocusTarget && trigger.isConnected && !trigger.hidden) trigger.focus({ preventScroll: true });
    else ports.fallbackFocus();
  } else if (reason === "escape") {
    const current = ownerDocument.activeElement;
    if (!(current && current !== ownerDocument.body && ports.canFocus(current as HTMLElement))) ports.fallbackFocus();
  }
}

/** Arrow keys, Home and End move between the entries. True when the key was one of them. */
function moveMenuFocus(menu: HTMLElement, ownerDocument: Document, key: string): boolean {
  const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  if (!buttons.length) return false;
  const at = buttons.indexOf(ownerDocument.activeElement as HTMLButtonElement);
  let next: number;
  if (key === "ArrowDown") next = (at + 1) % buttons.length;
  else if (key === "ArrowUp") next = (at - 1 + buttons.length) % buttons.length;
  else if (key === "Home") next = 0;
  else if (key === "End") next = buttons.length - 1;
  else return false; // Native Enter/Space activation fires exactly one click.
  buttons[next]?.focus({ preventScroll: true });
  return true;
}

/** Entries of an unbound menu are unavailable (aria-disabled). The menu itself is never marked busy:
 * some screen readers would then hold back its content. */
function markMenuEntries(menu: HTMLElement, available: boolean): void {
  for (const entry of menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')) {
    if (available) entry.removeAttribute("aria-disabled"); else entry.setAttribute("aria-disabled", "true");
  }
}

export function createMenu(root: HTMLElement, ports: MenuPorts): MenuController {
  const trigger = root.querySelector<HTMLButtonElement>('[data-act="more"]');
  const menu = root.querySelector<HTMLElement>('[role="menu"]');
  if (!trigger || !menu) throw new Error("Pane menu elements missing");
  menu.id = `pane-actions-menu-${++nextMenuId}`;
  trigger.setAttribute("aria-controls", menu.id);
  // Pane headers are created in an inert template document and adopted later.
  // Resolve the live document at interaction time, never at construction.
  const ownerDocument = (): Document => root.ownerDocument;
  let outsideDocument: Document | null = null;
  // An opening of the menu. Before the session list names the pane's session (its terminal attaches
  // first), no target can be captured: the menu still opens, its entries marked unavailable
  // (aria-disabled), and the next refresh() that can capture one binds it and enables them. Only a
  // bound menu holds a pending reload of the page (`hold`): an unbound one has nothing to lose.
  type Opening = { target: CapturedTarget | null; signature: string };
  let opened: Opening | null = null;
  const signature = (actions: readonly MenuAction[]): string => actions.map((action) => `${action.id}:${action.label}`).join("|");
  const hide = (reason: MenuCloseReason): void => {
    const menuHeldFocus = menu.contains(ownerDocument().activeElement);
    const triggerWasFocusTarget = menuHeldFocus && ports.canFocus(trigger);
    opened = null;
    outsideDocument?.removeEventListener("pointerdown", outside, true); outsideDocument = null;
    menu.hidden = true; trigger.setAttribute("aria-expanded", "false");
    focusAfterMenuHide(trigger, ports, ownerDocument(), { menuHeldFocus, triggerWasFocusTarget }, reason);
    ports.hold(false);
  };
  const close = (reason: MenuCloseReason = "invalidate"): void => {
    const original = opened;
    if (!original) return;
    hide(reason);
    if (original.target) ports.release(original.target);
  };
  const capture = (): CapturedTarget | null => {
    const target = ports.capture();
    if (target && ports.valid(target)) return target;
    if (target) ports.release(target);
    return null;
  };
  const entry = (opening: Opening, action: MenuAction): HTMLButtonElement => {
    const button = ownerDocument().createElement("button");
    button.type = "button"; button.setAttribute("role", "menuitem"); button.dataset.menuAction = action.id;
    button.textContent = action.label; button.className = action.danger ? "danger" : "";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (opened === opening && opening.target === null) return;   // not bound yet: the entry is unavailable
      const target = opening.target;
      if (opened !== opening || !target || !ports.valid(target)) { close(); return; }
      // End menu ownership before dispatch, retain only this callback's token.
      hide("invalidate");
      try {
        Promise.resolve(ports.run(action.id, target)).catch(ports.reportError).finally(() => ports.release(target));
      } catch (error) { ports.release(target); ports.reportError(error); }
    });
    return button;
  };
  const fill = (opening: Opening, actions: readonly MenuAction[]): void => {
    const heldFocus = menu.contains(ownerDocument().activeElement);
    opening.signature = signature(actions);
    menu.replaceChildren(...actions.map((action) => entry(opening, action)));
    markMenuEntries(menu, opening.target !== null);
    if (heldFocus) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  };
  const open = (): void => {
    if (opened) { close(); return; }
    if (!trigger.isConnected || trigger.disabled || trigger.closest("[hidden], [inert]") || trigger.getClientRects().length === 0) return;
    ports.activate();
    if (!ports.canFocus(trigger)) return;
    const actions = ports.actions();
    if (!actions.length) return;
    const opening: Opening = { target: capture(), signature: "" };
    opened = opening;
    fill(opening, actions);
    trigger.setAttribute("aria-expanded", "true"); menu.hidden = false;
    if (opening.target) ports.hold(true);
    outsideDocument = ownerDocument(); outsideDocument.addEventListener("pointerdown", outside, true);
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  };
  const triggerClick = (event: Event): void => { event.stopPropagation(); open(); };
  const keydown = (event: KeyboardEvent): void => {
    if (!opened) return;
    if (opened.target && !ports.valid(opened.target)) { close(); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close("escape"); return; }
    if (event.key === "Tab") { close("tab"); return; }
    if (moveMenuFocus(menu, ownerDocument(), event.key)) { event.preventDefault(); event.stopPropagation(); }
  };
  const outside = (event: PointerEvent): void => {
    const view = ownerDocument().defaultView;
    if (opened && view && event.target instanceof view.Node
      && !menu.contains(event.target) && !trigger.contains(event.target)) close("outside");
  };
  trigger.addEventListener("click", triggerClick);
  menu.addEventListener("keydown", keydown);
  const refresh = (): void => {
    const actions = ports.actions();
    trigger.hidden = actions.length === 0;
    const opening = opened;
    if (opening && opening.target === null && actions.length) {
      // Still unbound: follow the actions and bind as soon as a target can be captured.
      if (signature(actions) !== opening.signature) fill(opening, actions);
      opening.target = capture();
      markMenuEntries(menu, opening.target !== null);
      if (opening.target) ports.hold(true);
    } else if (opening && (!opening.target || !ports.valid(opening.target) || signature(actions) !== opening.signature)) close();
    if (!opened) trigger.setAttribute("aria-expanded", "false");
  };
  refresh();
  return { refresh, close, dispose() {
    close(); trigger.removeEventListener("click", triggerClick); menu.removeEventListener("keydown", keydown);
    outsideDocument?.removeEventListener("pointerdown", outside, true); outsideDocument = null;
  } };
}

// Phone direct writing: pure rules, in their own file.
export { directInput, directLineStarts, directLineTrigger, foregroundAgent } from "./direct-line.ts";
