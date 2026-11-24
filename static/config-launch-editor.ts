// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The editable part of the Configuration dialog: the enabled agents and the allowed work folders.
//
// Locked by default. "Edit" asks for the master token; the server grants a short elevation (an
// HttpOnly cookie, ten minutes) and this page only shows its countdown. The token lives in one
// password input, is sent once and cleared at once; it is never kept, logged or put in storage.
// Everything reaches the DOM through `textContent`/`value`, never markup. The server stays the
// authority on every rule; the checks here only give a readable message sooner.

import type { ConfigTranslate } from "./config-panel.ts";

export type LaunchView = Readonly<{
  editable: boolean; optionsEditable: boolean; revision: string | null; agents: readonly string[]; knownAgents: readonly string[];
  roots: readonly string[]; defaults: Readonly<{ agents: readonly string[]; roots: readonly string[] }>;
  maxRoots: number; maxPath: number;
  // The extra arguments the owner stored per agent, as the text the launch field holds, and the
  // revision of the file they live in ('' when there is no file yet).
  agentOptions: Readonly<Record<string, string>>; agentOptionsRevision: string;
}>;
export type Elevation = Readonly<{ active: boolean; secondsLeft: number }>;
export type ElevateResult = { ok: true; secondsLeft: number } | { ok: false; error: string; retryAfter: number | null };
export type SaveResult = { ok: true } | { ok: false; error: string; message: string | null };
export type LaunchNotice = "saved" | "stale";
export type LaunchPorts = Readonly<{
  t: ConfigTranslate;
  elevate: (token: string) => Promise<ElevateResult>;
  revoke: () => Promise<boolean>;
  save: (body: { revision: string; enabled_agents: string[]; workspace_roots: string[] }) => Promise<SaveResult>;
  saveOptions: (body: { revision: string; agent_options: Record<string, string> }) => Promise<SaveResult>;
  reload: (notice: LaunchNotice) => void;
}>;

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const natural = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;

export function parseLaunch(raw: unknown): LaunchView {
  const launch = record(raw), defaults = record(launch.defaults), limits = record(launch.limits);
  return {
    editable: launch.editable === true && typeof launch.revision === "string",
    optionsEditable: launch.agent_options_editable === true,
    revision: typeof launch.revision === "string" ? launch.revision : null,
    agents: strings(launch.enabled_agents), knownAgents: strings(launch.known_agents), roots: strings(launch.workspace_roots),
    defaults: { agents: strings(defaults.enabled_agents), roots: strings(defaults.workspace_roots) },
    maxRoots: natural(limits.max_roots, 16), maxPath: natural(limits.max_path, 1024),
    agentOptions: Object.fromEntries(Object.entries(record(launch.agent_options)).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
    agentOptionsRevision: typeof launch.agent_options_revision === 'string' ? launch.agent_options_revision : '',
  };
}

export function parseElevation(raw: unknown): Elevation {
  const value = record(raw), left = value.seconds_left;
  const secondsLeft = typeof left === "number" && Number.isSafeInteger(left) && left > 0 ? left : 0;
  return { active: value.active === true && secondsLeft > 0, secondsLeft };
}

type Mode = "locked" | "asking" | "editing";

export class LaunchEditor {
  readonly element: HTMLElement;
  private mode: Mode;
  private deadline = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private agents: Set<string>;
  private roots: string[];
  private options: Map<string, string>;
  private message: { text: string; ok: boolean } | null = null;
  private busy = false;
  private disposed = false;
  private clock: HTMLElement | null = null;

  private readonly doc: Document;
  private readonly view: LaunchView;
  private readonly ports: LaunchPorts;

  constructor(doc: Document, view: LaunchView, elevation: Elevation, ports: LaunchPorts, notice: LaunchNotice | null = null) {
    this.doc = doc; this.view = view; this.ports = ports;
    this.element = doc.createElement("section");
    this.element.className = "config-section config-card config-launch"; this.element.dataset.section = "launch";
    this.agents = new Set(view.agents); this.roots = [...view.roots];
    this.options = new Map(view.knownAgents.map((agent) => [agent, view.agentOptions[agent] ?? '']));
    this.mode = elevation.active && (view.editable || view.optionsEditable) ? "editing" : "locked";
    if (notice === "saved") this.message = { text: ports.t("config.launch.saved"), ok: true };
    if (notice === "stale") this.message = { text: ports.t("config.launch.err.stale"), ok: false };
    if (this.mode === "editing") this.startClock(elevation.secondsLeft);
    this.draw();
  }

  dispose(): void { this.disposed = true; this.stopClock(); }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", content?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  private button(label: string, onClick: () => void, className = "btn sm", disabled = false): HTMLButtonElement {
    const node = this.el("button", className, label);
    node.type = "button"; node.disabled = disabled || this.busy;
    node.addEventListener("click", onClick);
    return node;
  }

  private startClock(seconds: number): void {
    this.stopClock();
    this.deadline = Date.now() + seconds * 1000;
    this.timer = setInterval(() => {
      if (this.secondsLeft() > 0) { this.paintClock(); return; }
      this.stopClock(); this.mode = "locked"; this.message = { text: this.ports.t("config.launch.err.expired"), ok: false };
      this.draw();
    }, 1000);
  }

  private stopClock(): void { if (this.timer !== null) clearInterval(this.timer); this.timer = null; }
  private secondsLeft(): number { return Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000)); }

  private paintClock(): void {
    if (!this.clock) return;
    const left = this.secondsLeft();
    this.clock.textContent = this.ports.t("config.launch.unlocked",
      { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` });
  }

  private agentLabel(agent: string): string {
    return agent === "codex-yolo" ? this.ports.t("config.launch.codexYolo") : agent;
  }

  private draw(): void {
    const { t } = this.ports;
    const heading = this.el("h4", "", t("config.launch.title"));
    const parts: HTMLElement[] = [heading];
    if (this.mode === "editing") {
      if (!this.view.editable) parts.push(this.el("p", "mute", t("config.launch.noFile")), this.summary());
      parts.push(...this.editing());
    } else {
      parts.push(this.el("p", "mute", t(this.view.editable ? "config.launch.readonly" : "config.launch.noFile")), this.summary());
      if (this.view.editable || this.view.optionsEditable) {
        parts.push(this.mode === "asking" ? this.tokenForm() : this.button(t("config.launch.edit"),
          () => { this.mode = "asking"; this.message = null; this.draw(); this.element.querySelector("input")?.focus(); }, "btn sm primary config-edit"));
      }
    }
    if (this.message) {
      const line = this.el("p", this.message.ok ? "config-ok" : "config-error", this.message.text);
      line.setAttribute("role", this.message.ok ? "status" : "alert");
      parts.push(line);
    }
    this.clock = null;
    this.element.replaceChildren(...parts);
    this.clock = this.element.querySelector<HTMLElement>(".config-clock");
    this.paintClock();
  }

  private summary(): HTMLElement {
    const { t } = this.ports;
    const list = this.el("dl", "config-list");
    for (const [label, value] of [[t("config.launch.agents"), this.view.agents.map((a) => this.agentLabel(a)).join(", ")],
      [t("config.launch.roots"), this.view.roots.join(", ")]] as const) {
      const row = this.el("div", "config-row"), term = this.el("dt", "", label), detail = this.el("dd");
      detail.append(this.el("span", "config-value mono", value || t("config.none")));
      row.append(term, detail); list.append(row);
    }
    return list;
  }

  private tokenForm(): HTMLElement {
    const { t } = this.ports;
    const form = this.el("form", "config-token");
    const label = this.el("label", "", t("config.launch.token"));
    const input = this.el("input");
    input.type = "password"; input.autocomplete = "off"; input.spellcheck = false; input.required = true;
    input.setAttribute("aria-label", t("config.launch.token"));
    label.append(input);
    const actions = this.el("div", "config-actions");
    const submit = this.el("button", "btn sm primary", t("config.launch.unlock"));
    submit.type = "submit"; submit.disabled = this.busy;
    actions.append(submit, this.button(t("config.launch.cancel"), () => { this.mode = "locked"; this.message = null; this.draw(); }, "btn sm ghost"));
    form.append(label, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const token = input.value; input.value = "";
      if (token === "") return;
      void this.unlock(token);
    });
    return form;
  }

  private async unlock(token: string): Promise<void> {
    const { t } = this.ports;
    this.busy = true; this.draw();
    const result = await this.ports.elevate(token).catch(() => null);
    if (this.disposed) return;
    this.busy = false;
    if (result === null) this.message = { text: t("config.launch.err.network"), ok: false };
    else if (result.ok) {
      this.mode = "editing"; this.message = null; this.startClock(result.secondsLeft);
    } else {
      this.message = { ok: false, text: result.error === "too-many-attempts"
        ? t("config.launch.err.tooMany", { seconds: result.retryAfter ?? 0 }) : result.error === "wrong-token"
          ? t("config.launch.err.wrongToken") : t("config.launch.err.generic", { message: result.error }) };
    }
    this.draw();
  }

  private editing(): HTMLElement[] {
    const { t } = this.ports;
    const clock = this.el("p", "config-clock mute");
    clock.setAttribute("role", "timer");
    const lock = this.button(t("config.launch.lock"), () => { void this.lock(); }, "btn sm ghost");
    const bar = this.el("div", "config-bar"); bar.append(clock, lock);

    const agents = this.el("fieldset", "config-field");
    agents.append(this.el("legend", "", t("config.launch.agents")));
    for (const agent of this.view.knownAgents) {
      const label = this.el("label", "config-check"), box = this.el("input");
      box.type = "checkbox"; box.checked = this.agents.has(agent); box.dataset.agent = agent; box.disabled = this.busy;
      box.addEventListener("change", () => { if (box.checked) this.agents.add(agent); else this.agents.delete(agent); });
      label.append(box, this.doc.createTextNode(` ${this.agentLabel(agent)}`));
      agents.append(label);
    }
    agents.append(this.button(t("config.launch.default"), () => {
      this.agents = new Set(this.view.defaults.agents); this.message = null; this.draw();
    }, "btn sm ghost config-default-agents"));

    const roots = this.el("fieldset", "config-field");
    roots.append(this.el("legend", "", t("config.launch.roots")));
    const list = this.el("ul", "config-roots");
    for (const root of this.roots) {
      const item = this.el("li"); item.dataset.root = root;
      item.append(this.el("span", "config-value mono", root), this.button(t("config.launch.remove"), () => {
        this.roots = this.roots.filter((other) => other !== root); this.message = null; this.draw();
      }, "btn sm ghost config-remove"));
      item.lastElementChild?.setAttribute("aria-label", t("config.launch.removeAria", { path: root }));
      list.append(item);
    }
    const add = this.el("input", "config-new-root");
    add.type = "text"; add.placeholder = t("config.launch.folderPlaceholder"); add.autocomplete = "off"; add.spellcheck = false;
    add.setAttribute("aria-label", t("config.launch.addAria"));
    const append = () => { if (this.addRoot(add.value)) { this.draw(); this.element.querySelector<HTMLInputElement>(".config-new-root")?.focus(); } else this.showMessage(); };
    add.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); append(); } });
    const adder = this.el("div", "config-add");
    adder.append(add, this.button(t("config.launch.addFolder"), append, "btn sm config-add-root"));
    roots.append(list, adder, this.button(t("config.launch.default"), () => {
      this.roots = [...this.view.defaults.roots]; this.message = null; this.draw();
    }, "btn sm ghost config-default-roots"));

    const save = this.button(t("config.launch.save"), () => { void this.save(); }, "btn sm primary config-save");
    return [bar, ...(this.view.editable ? [agents, roots, this.el("p", "mute config-help", t("config.launch.help")), save] : []),
      ...(this.view.optionsEditable ? [this.optionsFieldset()] : [])];
  }

  /** One text field per known agent: what the launch dialog's options field holds, stored or cleared. */
  private optionsFieldset(): HTMLElement {
    const { t } = this.ports;
    const fieldset = this.el("fieldset", "config-field config-options");
    fieldset.append(this.el("legend", "", t("config.launch.options")));
    for (const agent of this.view.knownAgents) {
      const label = this.el("label", "config-option");
      label.append(this.el("span", "config-option-name", this.agentLabel(agent)));
      const input = this.el("input", "config-option-value");
      input.type = "text"; input.autocomplete = "off"; input.spellcheck = false;
      input.dataset.optionAgent = agent; input.value = this.options.get(agent) ?? "";
      input.placeholder = t("config.launch.optionsPlaceholder"); input.disabled = this.busy;
      input.setAttribute("aria-label", `${this.agentLabel(agent)}: ${t("config.launch.options")}`);
      input.addEventListener("input", () => this.options.set(agent, input.value));
      label.append(input);
      fieldset.append(label);
    }
    fieldset.append(this.el("p", "mute config-help", t("config.launch.optionsHelp")));
    fieldset.append(this.button(t("config.launch.saveOptions"), () => { void this.saveOptions(); },
      "btn sm primary config-save-options"));
    return fieldset;
  }

  private async saveOptions(): Promise<void> {
    const { t } = this.ports;
    const changed: Record<string, string> = {};
    for (const [agent, value] of this.options) {
      if (value !== (this.view.agentOptions[agent] ?? "")) changed[agent] = value;
    }
    if (Object.keys(changed).length === 0) { this.message = { text: t("config.launch.optionsUnchanged"), ok: true }; this.showMessage(); return; }
    const launchDirty = this.view.editable && (this.agents.size !== this.view.agents.length
      || this.view.agents.some((agent) => !this.agents.has(agent))
      || this.roots.length !== this.view.roots.length || this.roots.some((root, index) => root !== this.view.roots[index]));
    if (launchDirty && !this.doc.defaultView?.confirm(t("config.launch.discardLaunchDraft"))) return;
    this.busy = true; this.draw();
    const result = await this.ports.saveOptions({ revision: this.view.agentOptionsRevision, agent_options: changed }).catch(() => null);
    if (this.disposed) return;
    this.busy = false;
    if (result === null) { this.message = { text: t("config.launch.err.network"), ok: false }; this.draw(); return; }
    if (result.ok) { this.ports.reload("saved"); return; }
    if (result.error === "stale-revision") { this.stopClock(); this.ports.reload("stale"); return; }
    if (result.error === "elevation-required") {
      this.stopClock(); this.mode = "locked"; this.message = { text: t("config.launch.err.expired"), ok: false };
    } else {
      this.message = { text: result.message ?? t("config.launch.err.generic", { message: result.message ?? result.error }), ok: false };
    }
    this.draw();
  }

  private showMessage(): void {
    this.element.querySelector(".config-error, .config-ok")?.remove();
    if (!this.message) return;
    const line = this.el("p", this.message.ok ? "config-ok" : "config-error", this.message.text);
    line.setAttribute("role", this.message.ok ? "status" : "alert");
    this.element.append(line);
  }

  private addRoot(value: string): boolean {
    const { t } = this.ports, path = value.trim();
    const fail = (text: string) => { this.message = { text, ok: false }; return false; };
    if (path === "") return fail(t("config.launch.err.emptyPath"));
    if (!path.startsWith("/")) return fail(t("config.launch.err.relative"));
    if (path.length > this.view.maxPath) return fail(t("config.launch.err.long", { max: this.view.maxPath }));
    if (this.roots.includes(path)) return fail(t("config.launch.err.dup"));
    if (this.roots.length >= this.view.maxRoots) return fail(t("config.launch.err.tooManyFolders", { max: this.view.maxRoots }));
    this.roots.push(path); this.message = null;
    return true;
  }

  private async lock(): Promise<void> {
    // Locking the page is not revoking: when the server did not confirm, the elevation may still be
    // live, so the page stays unlocked and says so.
    const revoked = await this.ports.revoke().catch(() => false);
    if (this.disposed) return;
    if (!revoked) { this.message = { text: this.ports.t("config.launch.err.lockFailed"), ok: false }; this.draw(); return; }
    this.stopClock(); this.mode = "locked"; this.message = null; this.draw();
  }

  private async save(): Promise<void> {
    const { t } = this.ports;
    const fail = (text: string) => { this.message = { text, ok: false }; this.showMessage(); };
    if (this.agents.size === 0) return fail(t("config.launch.err.noAgent"));
    if (this.roots.length === 0) return fail(t("config.launch.err.noFolder"));
    if (this.view.revision === null) return fail(t("config.launch.noFile"));
    const optionsDirty = [...this.options].some(([agent, value]) => value !== (this.view.agentOptions[agent] ?? ""));
    if (optionsDirty && !this.doc.defaultView?.confirm(t("config.launch.discardOptionsDraft"))) return;
    this.busy = true; this.draw();
    const result = await this.ports.save({ revision: this.view.revision, enabled_agents: this.view.knownAgents.filter((a) => this.agents.has(a)),
      workspace_roots: [...this.roots] }).catch(() => null);
    if (this.disposed) return;
    this.busy = false;
    if (result === null) { this.message = { text: t("config.launch.err.network"), ok: false }; this.draw(); return; }
    if (result.ok) { this.ports.reload("saved"); return; }
    if (result.error === "stale-revision") { this.stopClock(); this.ports.reload("stale"); return; }
    if (result.error === "elevation-required") {
      this.stopClock(); this.mode = "locked"; this.message = { text: t("config.launch.err.expired"), ok: false };
    } else if (result.error === "file-changed") this.message = { text: t("config.launch.err.fileChanged"), ok: false };
    else this.message = { text: t("config.launch.err.generic", { message: result.message ?? result.error }), ok: false };
    this.draw();
  }
}
