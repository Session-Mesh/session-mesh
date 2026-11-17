// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The owner's read-only "Configuration" dialog: the effective paths, the served version, the
// terminal host, the detected agents, and the network and notification state, as GET /api/config
// reports them. Bundled into pane-actions.js, so it adds no served file.
//
// Everything reaches the DOM through `textContent`; the only control is a button that copies one
// path to the clipboard. The server never sends a secret, and the page shows nothing it did not
// receive. A value that is missing or of the wrong type is shown as "unknown", never guessed.

import { LaunchEditor, parseElevation, parseLaunch, type LaunchNotice, type LaunchPorts } from "./config-launch-editor.ts";

export type ConfigTranslate = (key: string, params?: Record<string, string | number>) => string;
export type ConfigLoad = () => Promise<{ state: "ok"; value: unknown } | { state: "error" }>;
export type ConfigElements = Readonly<{ dialog: HTMLDialogElement; body: HTMLElement }>;
export type ConfigPorts = Readonly<{
  t: ConfigTranslate; load: ConfigLoad; copy: (text: string) => Promise<boolean>;
  elevate: LaunchPorts["elevate"]; revoke: LaunchPorts["revoke"]; save: LaunchPorts["save"];
}>;

type Row = Readonly<{ label: string; value: string; copy: string | null; mono: boolean; hint: string | null }>;
type Section = Readonly<{ id: string; title: string; rows: readonly Row[] }>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === "string" && value !== "" && value.length <= 4096 ? value : null;
const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

type Context = Readonly<{
  t: ConfigTranslate; unknown: string;
  yes: (value: boolean | null, on: string, off: string) => string;
  plain: (label: string, value: string, hint?: string) => Row;
  env: (variable: string) => string;
}>;

// Where a folder or file comes from. Only the web server's unit environment sets these four.
const PATH_VARIABLES: Readonly<Record<string, string>> = {
  config_dir: "MESH_CONF_DIR", cache_dir: "MESH_CACHE_DIR", runtime_dir: "MESH_RUNTIME_DIR", launch_settings: "MESH_LAUNCH_SETTINGS",
};

const pathRow = (ctx: Context, paths: Record<string, unknown>, key: string, label: string, present?: boolean | null): Row => {
  const value = text(paths[key]);
  const mark = present === undefined || value === null ? "" : ` (${present ? ctx.t("config.present") : ctx.t("config.absent")})`;
  const variable = PATH_VARIABLES[key];
  const hint = variable === undefined ? ctx.t("config.hint.derived") : ctx.t("config.hint.system", { env: ctx.env(variable) });
  return { label, value: value === null ? ctx.t("config.notSet") : value + mark, copy: value, mono: true, hint };
};

function pathsSection(ctx: Context, paths: Record<string, unknown>): Section {
  const { t } = ctx, row = (key: string, label: string, present?: boolean | null) => pathRow(ctx, paths, key, label, present);
  return { id: "paths", title: t("config.paths"), rows: [
    row("config_dir", t("config.path.config")), row("runtime_dir", t("config.path.runtime")),
    row("host_socket", t("config.path.socket"), flag(paths.host_socket_present)),
    row("cache_dir", t("config.path.cache")), row("uploads_dir", t("config.path.uploads")),
    row("install_dir", t("config.path.install")), row("bin_dir", t("config.path.bin")),
    row("launch_settings", t("config.path.launchSettings")),
    row("mesh_open", t("config.path.meshOpen"), flag(paths.mesh_open_present)),
    row("mesh_open_on_path", t("config.path.meshOpenPath")),
    row("board_mcp", t("config.path.boardMcp"), flag(paths.board_mcp_present)),
  ] };
}

function versionSection(ctx: Context, version: Record<string, unknown>): Section {
  const { t, unknown, plain } = ctx, installName = text(version.install_name);
  return { id: "version", title: t("config.version"), rows: [
    plain(t("config.client"), text(version.client) ?? unknown, t("config.hint.derived")),
    plain(t("config.installName"), installName ?? unknown, t("config.hint.derived")),
  ] };
}

function hostSection(ctx: Context, host: Record<string, unknown>): Section {
  const { t, plain, yes } = ctx;
  const capabilities = Array.isArray(host.capabilities) ? host.capabilities.filter((c) => typeof c === "string") : [];
  const kind = text(host.kind);
  const kindText = kind === "native" ? t("config.host.native") : kind === "python" ? t("config.host.python")
    : kind === "other" ? t("config.host.other") : t("config.host.kindUnknown");
  const state = flag(host.running) === true && flag(host.reply_valid) === false ? t("config.host.invalidReply")
    : yes(flag(host.running), t("config.host.running"), t("config.host.stopped"));
  return { id: "host", title: t("config.host"), rows: [
    plain(t("config.host.state"), state, t("config.hint.hostNoRestart")),
    plain(t("config.host.kind"), kindText + (text(host.executable) ? ` (${text(host.executable)})` : ""), t("config.hint.hostNoRestart")),
    plain(t("config.host.version"), text(host.version) ?? t("config.notDetected")),
    plain(t("config.host.capabilities"), capabilities.length ? capabilities.join(", ") : t("config.host.noCapabilities")),
  ] };
}

function agentsSection(ctx: Context, agents: Record<string, unknown>[]): Section {
  const { t } = ctx;
  return { id: "agents", title: t("config.agents"), rows: agents.flatMap((entry): Row[] => {
    const name = text(entry.agent);
    if (name === null) return [];
    const found = text(entry.path);
    const state = [found ? t("config.found") : t("config.notFound"),
      flag(entry.enabled) === false ? t("config.disabled") : null,
      text(entry.version) ?? t("config.versionNotDetected")].filter(Boolean).join(" · ");
    return [{ label: name, value: found ? `${found} — ${state}` : state, copy: found, mono: true, hint: t("config.hint.agent") }];
  }) };
}

function networkSection(ctx: Context, network: Record<string, unknown>, launch: Record<string, unknown>): Section {
  const { t, unknown, plain, yes } = ctx;
  const roots = Array.isArray(launch.workspace_roots) ? launch.workspace_roots.filter((r) => typeof r === "string") : [];
  const tailscale = network.tailscale === "inferred" ? t("config.tailscale.inferred") : t("config.tailscale.notSeen");
  const listen = text(network.listen_host), port = count(network.port);
  return { id: "network", title: t("config.network"), rows: [
    plain(t("config.port"), port === null ? unknown : String(port), t("config.hint.env", { env: ctx.env("MESH_PORT") })),
    plain(t("config.listen"), (listen ?? unknown) + (flag(network.loopback_only) === false ? ` ${t("config.nonLoopback")}` : ""),
      t("config.hint.env", { env: ctx.env("MESH_HOST") })),
    plain(t("config.requestHost"), text(network.request_host) ? `${text(network.request_scheme) ?? "?"}://${text(network.request_host)}` : unknown,
      t("config.hint.request")),
    plain(t("config.tailscale"), tailscale, t("config.hint.request")),
    plain(t("config.trustProxy"), yes(flag(network.trust_proxy), t("config.yes"), t("config.no")),
      t("config.hint.env", { env: ctx.env("MESH_TRUST_PROXY") })),
    plain(t("config.workspaceRoots"), flag(launch.configured) === false ? t("config.anyFolder")
      : roots.length ? roots.join(", ") : unknown, t("config.hint.launch")),
  ] };
}

function notificationsSection(ctx: Context, notify: Record<string, unknown>, language: string): Section {
  const { t, unknown, plain, yes } = ctx, subscriptions = count(notify.subscriptions);
  return { id: "notifications", title: t("config.notifications"), rows: [
    plain(t("config.push.key"), yes(flag(notify.vapid_key_present), t("config.yes"), t("config.no")), t("config.hint.pushKey", { env: ctx.env("MESH_PUSH") })),
    plain(t("config.push.subscriptions"), subscriptions === null ? unknown : String(subscriptions), t("config.hint.subscriptions")),
    plain(t("config.language"), language, t("config.hint.language")),
  ] };
}

export function buildSections(raw: unknown, t: ConfigTranslate, language: string): Section[] {
  const root = record(raw);
  const unknown = t("config.unknown");
  const ctx: Context = { t, unknown,
    yes: (value, on, off) => value === null ? unknown : value ? on : off,
    plain: (label, value, hint) => ({ label, value, copy: null, mono: false, hint: hint ?? null }),
    env: (variable) => variable };
  const agents = Array.isArray(root.agents) ? root.agents.map(record) : [];
  return [
    pathsSection(ctx, record(root.paths)), versionSection(ctx, record(root.version)), hostSection(ctx, record(root.host)),
    agentsSection(ctx, agents), networkSection(ctx, record(root.network), record(root.launch)),
    notificationsSection(ctx, record(root.notifications), language),
  ];
}

export class ConfigPanel {
  private generation = 0;
  private editor: LaunchEditor | null = null;
  private readonly elements: ConfigElements;
  private readonly ports: ConfigPorts;
  private readonly language: () => string;
  constructor(elements: ConfigElements, ports: ConfigPorts, language: () => string) {
    this.elements = elements; this.ports = ports; this.language = language;
    elements.dialog.addEventListener("close", () => {
      this.generation += 1; this.editor?.dispose(); this.editor = null; elements.body.replaceChildren();
    });
  }

  private note(message: string): HTMLElement {
    const line = this.elements.dialog.ownerDocument.createElement("p");
    line.className = "mute"; line.setAttribute("role", "status"); line.textContent = message;
    return line;
  }

  private render(sections: readonly Section[]): HTMLElement[] {
    const doc = this.elements.dialog.ownerDocument;
    return sections.map((section) => {
      const block = doc.createElement("section");
      block.className = "config-section"; block.dataset.section = section.id;
      const heading = doc.createElement("h3");
      heading.textContent = section.title;
      const list = doc.createElement("dl");
      list.className = "config-list";
      for (const row of section.rows) {
        const item = doc.createElement("div"), term = doc.createElement("dt"), value = doc.createElement("dd");
        item.className = "config-row"; term.textContent = row.label;
        const span = doc.createElement("span");
        span.className = row.mono ? "config-value mono" : "config-value"; span.textContent = row.value;
        value.append(span);
        if (row.copy !== null) value.append(this.copyButton(row.label, row.copy));
        if (row.hint !== null) { const hint = doc.createElement("small"); hint.className = "config-hint mute"; hint.textContent = row.hint; value.append(hint); }
        item.append(term, value); list.append(item);
      }
      block.append(heading, list);
      return block;
    });
  }

  private copyButton(label: string, copied: string): HTMLButtonElement {
    const button = this.elements.dialog.ownerDocument.createElement("button");
    const { t } = this.ports;
    button.type = "button"; button.className = "btn ghost sm config-copy";
    button.textContent = t("config.copy");
    button.setAttribute("aria-label", t("config.copyAria", { label }));
    button.addEventListener("click", () => {
      void this.ports.copy(copied).then((ok) => {
        button.textContent = ok ? t("config.copied") : t("config.copyFailed");
        setTimeout(() => { button.textContent = t("config.copy"); }, 1500);
      });
    });
    return button;
  }

  private async load(notice: LaunchNotice | null = null): Promise<void> {
    const { dialog, body } = this.elements;
    const mine = ++this.generation;
    const result = await this.ports.load().catch(() => ({ state: "error" as const }));
    if (mine !== this.generation || !dialog.open) return;
    this.editor?.dispose(); this.editor = null;
    if (result.state !== "ok") { body.replaceChildren(this.note(this.ports.t("config.loadFailed"))); return; }
    const raw = record(result.value);
    const { t, elevate, revoke, save } = this.ports;
    this.editor = new LaunchEditor(dialog.ownerDocument, parseLaunch(raw.launch), parseElevation(raw.elevation),
      { t, elevate, revoke, save, reload: (next) => { void this.load(next); } }, notice);
    const sections = this.render(buildSections(result.value, t, this.language()));
    const at = sections.findIndex((section) => section.dataset.section === "agents");
    sections.splice(at < 0 ? sections.length : at + 1, 0, this.editor.element);
    body.replaceChildren(...sections);
  }

  open(): boolean {
    const { dialog, body } = this.elements;
    if (dialog.open) return false;
    body.replaceChildren(this.note(this.ports.t("common.loading")));
    dialog.showModal();
    void this.load();
    return true;
  }
}

export function createConfigPanel(elements: ConfigElements, ports: ConfigPorts, language: () => string): ConfigPanel {
  return new ConfigPanel(elements, ports, language);
}
