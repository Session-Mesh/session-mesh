// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The owner's mailbox for one session: the messages it received and sent, the approval requests
// that concern it and the permanent permissions that concern it. Bundled into pane-actions.js,
// so it adds no served file.
//
// Everything an agent wrote (a message text, a session name) reaches the DOM through
// `textContent` only: no markup is parsed, no link is made, nothing is run. Control characters
// and bidirectional overrides are shown as visible `<U+XXXX>` marks, so a text cannot reorder
// what the owner reads. Reading here grants the agent nothing: the decision and the revocation
// go through the existing owner routes.

export type MailIdentity = Readonly<{ id: string; created: number; agent: string }>;
export type MailMessage = Readonly<{
  id: string; conversation_id: string; source: MailIdentity; target: MailIdentity;
  kind: "message" | "task"; text: string; created: number; seq: number;
}>;
export type MailRequest = Readonly<{
  id: string; message_id: string; state: "pending"; source: MailIdentity; target: MailIdentity; created: number;
}>;
export type MailPolicy = Readonly<{ id: string; source: MailIdentity; target: MailIdentity; created: number }>;
export type MailboxView = Readonly<{
  identity: MailIdentity; received: readonly MailMessage[]; sent: readonly MailMessage[];
  truncated: boolean; requests: readonly MailRequest[]; always: readonly MailPolicy[];
}>;
export type MailDecision = "no" | "yes" | "always";
export type MailOutcome = "settled" | "stale" | "retry";
export type MailTranslate = (key: string, params?: Record<string, string | number>) => string;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function identityOf(value: unknown): MailIdentity | null {
  const item = record(value);
  if (!item || typeof item.id !== "string" || !item.id || !finite(item.created)
    || typeof item.agent !== "string" || !item.agent) return null;
  return { id: item.id, created: item.created, agent: item.agent };
}

function messageOf(value: unknown): MailMessage | null {
  const item = record(value);
  const source = identityOf(item?.source), target = identityOf(item?.target);
  if (!item || !source || !target || typeof item.id !== "string" || typeof item.conversation_id !== "string"
    || (item.kind !== "message" && item.kind !== "task") || typeof item.text !== "string"
    || !finite(item.created) || !finite(item.seq)) return null;
  return { id: item.id, conversation_id: item.conversation_id, source, target, kind: item.kind,
    text: item.text, created: item.created, seq: item.seq };
}

function requestOf(value: unknown): MailRequest | null {
  const item = record(value);
  const source = identityOf(item?.source), target = identityOf(item?.target);
  if (!item || !source || !target || typeof item.id !== "string" || !item.id
    || typeof item.message_id !== "string" || item.state !== "pending" || !finite(item.created)) return null;
  return { id: item.id, message_id: item.message_id, state: "pending", source, target, created: item.created };
}

function policyOf(value: unknown): MailPolicy | null {
  const item = record(value);
  const source = identityOf(item?.source), target = identityOf(item?.target);
  if (!item || !source || !target || typeof item.id !== "string" || !item.id || !finite(item.created)) return null;
  return { id: item.id, source, target, created: item.created };
}

function listOf<T>(value: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parse);
  return parsed.every((item): item is T => item !== null) ? parsed : null;
}

/** A server answer with the exact shape, or null: a malformed answer is never shown. */
export function parseMailbox(value: unknown): MailboxView | null {
  const item = record(value);
  const identity = identityOf(item?.identity);
  const received = listOf(item?.received, messageOf), sent = listOf(item?.sent, messageOf);
  const requests = listOf(item?.requests, requestOf), always = listOf(item?.always, policyOf);
  if (!item || !identity || !received || !sent || !requests || !always || typeof item.truncated !== "boolean") return null;
  return { identity, received, sent, truncated: item.truncated, requests, always };
}

const same = (a: MailIdentity, name: string, created: number): boolean => a.id === name && a.created === created;

/** Pending approval requests of an inventory snapshot that concern one session. */
export function requestsFor(requests: unknown, name: string, created: number): MailRequest[] {
  return (Array.isArray(requests) ? requests : []).map(requestOf)
    .filter((item): item is MailRequest => item !== null
      && (same(item.source, name, created) || same(item.target, name, created)));
}

// Marked: C0/C1 controls (newline and tab stay), the line and paragraph separators, every Unicode
// format character (category Cf: bidirectional controls and isolates, zero-width characters, soft
// hyphen, Arabic letter mark, word joiner, byte-order mark, ...), the whole tag block
// U+E0000-U+E007F and every variation selector (U+180B-U+180D, U+180F, U+FE00-U+FE0F,
// U+E0100-U+E01EF). None of them has a glyph of its own, so none may pass unmarked.
const UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u{E0000}-\u{E007F}\p{Cf}\p{Variation_Selector}]/gu;
/** The text to show: line ends normalised, invisible and reordering characters made visible. */
export function inertText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(UNSAFE,
    (char) => `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}>`);
}

const MAILBOX_AGENTS: ReadonlySet<string> = new Set(["claude", "codex", "pi"]);
/**
 * Whether an inventory entry has a mailbox: a session the app launched as one of the messaging
 * agents. This is the page's own launch provenance (`known_agent`), the field the server uses
 * to decide that a session is an agent session; a plain shell has none.
 */
export function hasMailbox(session: unknown): boolean {
  const known = record(session)?.known_agent;
  return typeof known === "string" && MAILBOX_AGENTS.has(known);
}

export interface MailboxPorts {
  readonly t: MailTranslate;
  readonly locale: () => string;
  readonly load: (name: string, created: number) => Promise<{ state: "ok"; value: unknown } | { state: "gone" | "error" }>;
  readonly decide: (requestId: string, decision: MailDecision) => Promise<MailOutcome>;
  readonly revoke: (policyId: string) => Promise<MailOutcome>;
  /** True while the session's last wake line was not followed by a look at its inbox. */
  readonly wakeUnconfirmed: (name: string, created: number) => boolean;
}

type Draw = Readonly<{ document: Document; t: MailTranslate; when: (seconds: number) => string;
  act: (run: () => Promise<MailOutcome>, stale: string) => void }>;

function element<K extends keyof HTMLElementTagNameMap>(draw: Draw, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = draw.document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function heading(draw: Draw, text: string): HTMLElement {
  return element(draw, "h3", "mailbox-heading", text);
}

function actionButton(draw: Draw, text: string, className: string, stale: string,
  run: () => Promise<MailOutcome>): HTMLButtonElement {
  const button = element(draw, "button", `btn ${className}`, text);
  button.type = "button";
  button.addEventListener("click", () => draw.act(run, stale));
  return button;
}

function requestRow(draw: Draw, request: MailRequest, ports: MailboxPorts): HTMLElement {
  const row = element(draw, "li", "mailbox-request");
  const line = element(draw, "p", "", draw.t("mailbox.requestLine", { target: request.target.id,
    source: request.source.id, agent: request.source.agent, time: draw.when(request.created) }));
  const actions = element(draw, "div", "mailbox-actions");
  const choose = (decision: MailDecision) => () => ports.decide(request.id, decision);
  actions.append(
    actionButton(draw, draw.t("mail.refuse"), "danger", "mailbox.alreadyDecided", choose("no")),
    actionButton(draw, draw.t("mail.once"), "", "mailbox.alreadyDecided", choose("yes")),
    actionButton(draw, draw.t("mail.always"), "primary", "mailbox.alreadyDecided", choose("always")));
  row.append(line, actions);
  return row;
}

function messageRow(draw: Draw, message: MailMessage, incoming: boolean): HTMLElement {
  const row = element(draw, "li", incoming ? "mailbox-message incoming" : "mailbox-message outgoing");
  const peer = incoming ? message.source : message.target;
  const params = { peer: peer.id, agent: peer.agent, kind: draw.t(`mailbox.kind.${message.kind}`),
    time: draw.when(message.created) };
  row.append(element(draw, "p", "mailbox-meta", draw.t(incoming ? "mailbox.fromHeader" : "mailbox.toHeader", params)),
    element(draw, "pre", "mailbox-text", inertText(message.text)));
  return row;
}

function policyRow(draw: Draw, policy: MailPolicy, name: string, created: number, ports: MailboxPorts): HTMLElement {
  const reader = same(policy.target, name, created);
  const peer = reader ? policy.source : policy.target;
  const row = element(draw, "li", "mailbox-policy");
  row.append(element(draw, "span", "", draw.t(reader ? "mailbox.policyIn" : "mailbox.policyOut",
    { peer: peer.id, agent: peer.agent })),
  actionButton(draw, draw.t("mailbox.revoke"), "danger", "mailbox.alreadyRevoked", () => ports.revoke(policy.id)));
  return row;
}

function section(draw: Draw, title: string, rows: readonly HTMLElement[], empty: string): HTMLElement {
  const block = element(draw, "section", "mailbox-section");
  block.append(heading(draw, title));
  if (!rows.length) { block.append(element(draw, "p", "mute", empty)); return block; }
  const list = element(draw, "ul", "mailbox-list");
  list.append(...rows);
  block.append(list);
  return block;
}

/** Build the whole view for one session; the caller replaces the dialog body with it. */
export function renderMailbox(draw: Draw, view: MailboxView, name: string, created: number,
  ports: MailboxPorts): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  if (view.requests.length) {
    const list = element(draw, "ul", "mailbox-list");
    list.append(...view.requests.map((request) => requestRow(draw, request, ports)));
    const block = element(draw, "section", "mailbox-section mailbox-requests");
    block.append(heading(draw, draw.t("mailbox.requests")), list);
    blocks.push(block);
  }
  // Newest first: the last message is what the owner usually looks for.
  const newest = (messages: readonly MailMessage[]) => [...messages].sort((a, b) => b.seq - a.seq);
  blocks.push(
    section(draw, draw.t("mailbox.received"), newest(view.received).map((m) => messageRow(draw, m, true)),
      draw.t("mailbox.noneReceived")),
    section(draw, draw.t("mailbox.sent"), newest(view.sent).map((m) => messageRow(draw, m, false)),
      draw.t("mailbox.noneSent")));
  if (view.truncated) blocks.push(element(draw, "p", "mute", draw.t("mailbox.truncated")));
  blocks.push(section(draw, draw.t("mailbox.permissions"),
    view.always.map((policy) => policyRow(draw, policy, name, created, ports)), draw.t("mailbox.noPermissions")));
  return blocks;
}

export interface MailboxElements {
  readonly dialog: HTMLDialogElement;
  readonly session: HTMLElement;
  readonly body: HTMLElement;
}

/**
 * The mailbox dialog. It loads when it opens and again when the set of approval requests that
 * concern its session changes (the page already learns those with each inventory snapshot); it
 * never polls. `pending` feeds the badge of a session's button.
 */
class MailboxPanel {
  private readonly elements: MailboxElements;
  private readonly ports: MailboxPorts;
  private shown: { name: string; created: number } | null = null;
  private known: unknown = [];
  private generation = 0;
  private busy = false;

  constructor(elements: MailboxElements, ports: MailboxPorts) {
    this.elements = elements;
    this.ports = ports;
    elements.dialog.addEventListener("close", () => {
      this.generation += 1; this.shown = null; elements.body.replaceChildren();
    });
  }

  private draw(): Draw {
    const { ports } = this;
    return {
      document: this.elements.dialog.ownerDocument, t: ports.t,
      when: (seconds) => new Date(seconds * 1000).toLocaleString(ports.locale()),
      act: (run, stale) => { void this.act(run, stale); },
    };
  }

  private paragraph(text: string): HTMLElement {
    const line = this.elements.dialog.ownerDocument.createElement("p");
    line.className = "mute"; line.setAttribute("role", "status"); line.textContent = text;
    return line;
  }

  private async load(): Promise<void> {
    const wanted = this.shown, { dialog, session, body } = this.elements, { ports } = this;
    if (!wanted) return;
    const mine = ++this.generation;
    const result = await ports.load(wanted.name, wanted.created).catch(() => ({ state: "error" as const }));
    if (mine !== this.generation || !dialog.open) return;
    if (result.state === "gone") { body.replaceChildren(this.paragraph(ports.t("mailbox.unavailable"))); return; }
    const view = result.state === "ok" ? parseMailbox(result.value) : null;
    if (!view) { body.replaceChildren(this.paragraph(ports.t("mailbox.loadFailed"))); return; }
    session.textContent = ports.t("mailbox.session", { name: wanted.name, agent: view.identity.agent });
    body.replaceChildren(...renderMailbox(this.draw(), view, wanted.name, wanted.created, ports));
    if (ports.wakeUnconfirmed(wanted.name, wanted.created)) {
      const note = this.paragraph(ports.t("mailbox.wakeUnconfirmed"));
      note.classList.add("wake-unconfirmed");
      body.prepend(note);
    }
  }

  private async act(run: () => Promise<MailOutcome>, stale: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const { dialog, body } = this.elements;
    body.setAttribute("aria-busy", "true");
    try {
      const outcome = await run().catch(() => "retry" as const);
      await this.load();
      if (outcome !== "settled" && dialog.open) {
        body.prepend(this.paragraph(this.ports.t(outcome === "stale" ? stale : "mailbox.actionFailed")));
      }
    } finally { this.busy = false; body.removeAttribute("aria-busy"); }
  }

  private signature(): string {
    const at = this.shown;
    return at ? requestsFor(this.known, at.name, at.created).map((item) => item.id).sort().join(",") : "";
  }

  open(name: string, created: number): boolean {
    const { dialog, session, body } = this.elements;
    if (dialog.open) return false;
    this.shown = { name, created };
    session.textContent = this.ports.t("mailbox.session", { name, agent: "…" });
    body.replaceChildren(this.paragraph(this.ports.t("common.loading")));
    dialog.showModal();
    void this.load();
    return true;
  }

  /** Each inventory snapshot: remembers the requests and reloads an open dialog if they changed. */
  note(requests: unknown): void {
    const before = this.signature();
    this.known = requests;
    if (this.shown && this.elements.dialog.open && !this.busy && this.signature() !== before) void this.load();
  }

  pending(name: string, created: number): number {
    return requestsFor(this.known, name, created).length;
  }
}

export function createMailboxPanel(elements: MailboxElements, ports: MailboxPorts): MailboxPanel {
  return new MailboxPanel(elements, ports);
}
