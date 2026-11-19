// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The agent-message approval prompt: the gate that picks which pending request to ask about, and
// the single dialog that asks. Bundled into pane-actions.js, so it adds no served file.

export type AgentMailConsentRequest = Readonly<{
  id: string;
  message_id: string;
  state: "pending";
  source: Readonly<{ id: string; created: number; agent: string }>;
  target: Readonly<{ id: string; created: number; agent: string }>;
}>;

/** "withdrawn": the request left the pending list while it was shown. "overtaken": it was
 * answered here, but left the pending list before the dialog finished closing. */
export type AgentMailConsentChoice = "no" | "yes" | "always" | "later" | "withdrawn" | "overtaken" | null;

/** What the next prompt of a run says about the one before it. */
export type AgentMailConsentNotice = "withdrawn" | "answeredElsewhere" | null;

export type AgentMailConsentGatePorts = Readonly<{
  choose: (request: AgentMailConsentRequest, notice: AgentMailConsentNotice) => Promise<AgentMailConsentChoice>;
  decide: (id: string, decision: "no" | "yes" | "always") => Promise<"settled" | "stale" | "retry">;
  withdraw?: (id: string) => void | Promise<void>;
  answeredElsewhere?: () => void;
  now?: () => number;
  deferMs?: number;
}>;

type GateState = {
  readonly handled: Set<string>;
  readonly deferredUntil: Map<string, number>;
  readonly now: () => number;
  readonly deferMs: number;
  latest: readonly unknown[];
  shown: string | null;
  closing: Promise<void> | null;
  running: boolean;
};

type Step = Readonly<{ stop: boolean; notice: AgentMailConsentNotice }>;
const NEXT: Step = { stop: false, notice: null };

function validRequest(value: unknown): value is AgentMailConsentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Partial<AgentMailConsentRequest>;
  return typeof request.id === "string" && request.id.length > 0
    && typeof request.message_id === "string" && request.message_id.length > 0
    && request.state === "pending" && !!request.source && !!request.target
    && typeof request.source.id === "string" && typeof request.target.id === "string"
    && typeof request.source.created === "number" && Number.isFinite(request.source.created)
    && typeof request.target.created === "number" && Number.isFinite(request.target.created);
}

function nextRequest(state: GateState, skip: ReadonlySet<string>): AgentMailConsentRequest | undefined {
  for (const value of state.latest) {
    if (!validRequest(value) || state.handled.has(value.id) || skip.has(value.id)) continue;
    const deferred = state.deferredUntil.get(value.id);
    if (deferred === undefined || state.now() >= deferred) return value;
  }
  return undefined;
}

/** Wait until a withdrawn prompt has finished closing; true when the prompt was withdrawn.
 * The next prompt never opens before that. */
async function finishClosing(state: GateState): Promise<boolean> {
  const closed = state.closing;
  if (closed === null) return false;
  state.closing = null;
  await closed;
  return true;
}

/** A prompt that ended without an answer to act on. A withdrawn prompt is asked again only if a
 * later list has it pending, never again in the same run. */
function setAside(state: GateState, request: AgentMailConsentRequest, skip: Set<string>,
  decision: AgentMailConsentChoice, ports: AgentMailConsentGatePorts): Step {
  state.handled.delete(request.id);
  skip.add(request.id);
  if (decision === null) return { stop: true, notice: null };
  if (decision === "overtaken") {
    ports.answeredElsewhere?.();
    return { stop: false, notice: "answeredElsewhere" };
  }
  return { stop: false, notice: decision === "withdrawn" ? "withdrawn" : null };
}

/** Show one prompt and act on its answer. */
async function ask(state: GateState, ports: AgentMailConsentGatePorts, request: AgentMailConsentRequest,
  skip: Set<string>, notice: AgentMailConsentNotice): Promise<Step> {
  state.deferredUntil.delete(request.id);
  state.handled.add(request.id);
  state.shown = request.id;
  let decision: AgentMailConsentChoice;
  try { decision = await ports.choose(request, notice); } finally { state.shown = null; }
  const withdrawn = await finishClosing(state);
  if (decision === null || decision === "withdrawn" || decision === "overtaken" || (withdrawn && decision === "later")) {
    return setAside(state, request, skip, decision, ports);
  }
  // Closing or deferring the Mesh dialog is not a refusal.  In particular, mobile browsers may
  // dismiss a dialog while the PWA is backgrounded; only an explicit "no" may destroy a message.
  if (decision === "later") {
    state.deferredUntil.set(request.id, state.now() + state.deferMs);
    state.handled.delete(request.id);
    return NEXT;
  }
  const outcome = await ports.decide(request.id, decision);
  if (outcome === "retry") { state.handled.delete(request.id); skip.add(request.id); }
  if (outcome !== "stale") return NEXT;
  ports.answeredElsewhere?.();
  return { stop: false, notice: "answeredElsewhere" };
}

/** The only loop that opens prompts; it reads the newest list before each one. */
async function run(state: GateState, ports: AgentMailConsentGatePorts): Promise<void> {
  state.running = true;
  const skip = new Set<string>();
  let notice: AgentMailConsentNotice = null;
  try {
    for (let request = nextRequest(state, skip); request !== undefined; request = nextRequest(state, skip)) {
      const step = await ask(state, ports, request, skip, notice);
      if (step.stop) return;
      notice = step.notice;
    }
  } finally { state.running = false; }
}

/** Ask about peer metadata only; message text stays behind the server gate.
 *
 * Every viewer of the mesh is asked. The server keeps the first answer; a
 * request that leaves the pending list while this viewer still shows it was
 * answered elsewhere, so `withdraw` closes the prompt and `choose` then
 * resolves "withdrawn". An answer the server no longer accepts ("stale"), or
 * one overtaken by such a list ("overtaken"), is reported through
 * `answeredElsewhere`. The next prompt of the same run receives a notice
 * saying what became of the previous one.
 *
 * One run at a time opens prompts. A `consider` call during a run only
 * records the newest list and withdraws the open prompt if that list no
 * longer holds it; the run picks its next request from the newest list, and
 * waits for a withdrawn prompt to finish closing before opening another. */
export function createAgentMailConsentGate(ports: AgentMailConsentGatePorts) {
  const state: GateState = {
    handled: new Set(), deferredUntil: new Map(), now: ports.now ?? Date.now,
    deferMs: Math.max(1, ports.deferMs ?? 60_000), latest: [], shown: null, closing: null, running: false,
  };
  const pending = (id: string) => state.latest.some((value) => validRequest(value) && value.id === id);
  return {
    consider(values: unknown): Promise<void> {
      if (!Array.isArray(values)) return Promise.resolve();
      state.latest = values;
      if (state.shown !== null && state.closing === null && !pending(state.shown)) {
        state.closing = Promise.resolve(ports.withdraw?.(state.shown)).then(() => undefined, () => undefined);
      }
      return state.running ? Promise.resolve() : run(state, ports);
    },
  };
}

type AgentMailConsentDialog = Pick<HTMLDialogElement,
  "open" | "returnValue" | "showModal" | "close" | "addEventListener" | "removeEventListener">;

export type AgentMailConsentPromptPorts = Readonly<{
  blocked: () => boolean;
  describe: (request: AgentMailConsentRequest) => void;
  /** Set the dialog's status line; called once the dialog is open, with null to clear it. */
  notice?: (notice: AgentMailConsentNotice) => void;
  withdrawn?: () => void;
}>;

type Answer = "no" | "yes" | "always" | "later";
type Current = { id: string; resolve: (choice: AgentMailConsentChoice) => void } | null;
const ANSWERS: readonly string[] = ["no", "yes", "always", "later"];
const answerOf = (value: string): Answer => ANSWERS.includes(value) ? value as Answer : "later";

/** The single approval dialog behind the gate's `choose` and `withdraw` ports.
 *
 * A browser fires a dialog's `close` event in a later task. `withdraw`
 * therefore settles the open prompt itself, and a `close` event that arrives
 * when no prompt is current, or after the dialog was opened again, is ignored.
 * The promise `withdraw` returns resolves once that `close` event has fired.
 * A `withdraw` that finds the dialog already closed on an explicit answer
 * settles the prompt as "overtaken". */
export function createAgentMailConsentPrompt(dialog: AgentMailConsentDialog, ports: AgentMailConsentPromptPorts) {
  let current: Current = null;
  dialog.addEventListener("close", () => {
    const prompt = current;
    if (prompt === null || dialog.open) return;
    current = null;
    prompt.resolve(answerOf(dialog.returnValue));
  });
  const open = (request: AgentMailConsentRequest, notice: AgentMailConsentNotice,
    resolve: (choice: AgentMailConsentChoice) => void): void => {
    if (current !== null || ports.blocked()) { resolve(null); return; }
    ports.describe(request);
    dialog.returnValue = "later";
    current = { id: request.id, resolve };
    try { dialog.showModal(); } catch { current = null; resolve(null); return; }
    ports.notice?.(notice);
  };
  const withdraw = (id: string): Promise<void> => {
    if (current === null || current.id !== id) return Promise.resolve();
    const prompt = current;
    current = null;
    if (!dialog.open) {
      prompt.resolve(answerOf(dialog.returnValue) === "later" ? "withdrawn" : "overtaken");
      return Promise.resolve();
    }
    prompt.resolve("withdrawn");
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => { ports.withdrawn?.(); resolve(); }, { once: true });
      dialog.close("withdrawn");
    });
  };
  return {
    choose: (request: AgentMailConsentRequest, notice: AgentMailConsentNotice = null): Promise<AgentMailConsentChoice> =>
      new Promise((resolve) => open(request, notice, resolve)),
    withdraw,
  };
}
