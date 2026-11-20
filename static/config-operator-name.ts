// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The "Operator name" card of the Configuration dialog: the runner setting `operator_name`
// (operator-name.ts), shared by every device of this runner. Saving goes through the launch
// settings route with a body {"settings": {...}} and needs the same short elevation (the master
// token, typed again): when the server asks for it, the card shows the token field, then saves.
// The token is sent once and cleared at once. Everything reaches the DOM as text or input values.

import type { ConfigTranslate } from "./config-panel.ts";
import type { ElevateResult } from "./config-launch-editor.ts";
import { OPERATOR_NAME_EVENT, OPERATOR_NAME_MAX, cleanOperatorName, operatorNameOfConfig, operatorNameProblem } from "./operator-name.ts";

export type RunnerSettingsResult = { ok: true; value: unknown } | { ok: false; error: string };
export type OperatorNamePorts = Readonly<{
  t: ConfigTranslate;
  elevate: (token: string) => Promise<ElevateResult>;
  saveSettings: (settings: { operator_name: string }) => Promise<RunnerSettingsResult>;
}>;

type Message = Readonly<{ text: string; ok: boolean }>;

export class OperatorNameCard {
  readonly element: HTMLElement;
  private readonly doc: Document;
  private readonly ports: OperatorNamePorts;
  private readonly input: HTMLInputElement;
  private readonly token: HTMLFormElement;
  private readonly status: HTMLElement;
  private readonly save: HTMLButtonElement;

  constructor(doc: Document, config: unknown, ports: OperatorNamePorts) {
    this.doc = doc; this.ports = ports;
    const { t } = ports;
    const card = this.element = this.make("section", "config-section config-card config-operator");
    card.dataset.section = "operator";
    const label = this.make("label", "config-operator-label", t("config.operator.label", { max: OPERATOR_NAME_MAX }));
    const input = this.input = this.make("input", "config-operator-name");
    input.type = "text"; input.autocomplete = "off"; input.spellcheck = false; input.maxLength = OPERATOR_NAME_MAX * 2;
    input.value = operatorNameOfConfig(config);
    label.append(input);
    this.save = this.make("button", "btn sm primary config-operator-save", t("config.operator.save"));
    this.save.type = "button";
    this.save.addEventListener("click", () => { void this.submit(); });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void this.submit(); } });
    this.token = this.tokenForm();
    this.status = this.make("p", "config-operator-status");
    this.status.hidden = true;
    card.append(this.make("h4", "", t("config.operator.title")), this.make("p", "mute config-help", t("config.operator.help")),
      label, this.save, this.token, this.status);
  }

  private make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, content?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag);
    node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  private say(message: Message | null): void {
    this.status.hidden = message === null;
    this.status.className = `config-operator-status ${message?.ok ? "config-ok" : "config-error"}`;
    this.status.setAttribute("role", message?.ok ? "status" : "alert");
    this.status.textContent = message?.text ?? "";
  }

  private busy(on: boolean): void {
    this.save.disabled = on; this.input.disabled = on;
    for (const control of this.token.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) control.disabled = on;
  }

  private tokenForm(): HTMLFormElement {
    const { t } = this.ports;
    const form = this.make("form", "config-token config-operator-token");
    form.hidden = true;
    const label = this.make("label", "", t("config.launch.token"));
    const input = this.make("input", "");
    input.type = "password"; input.autocomplete = "off"; input.spellcheck = false;
    input.setAttribute("aria-label", t("config.launch.token"));
    label.append(input);
    const unlock = this.make("button", "btn sm primary", t("config.launch.unlock"));
    unlock.type = "submit";
    const cancel = this.make("button", "btn sm ghost", t("config.launch.cancel"));
    cancel.type = "button";
    cancel.addEventListener("click", () => { form.hidden = true; input.value = ""; this.say(null); });
    const actions = this.make("div", "config-actions");
    actions.append(unlock, cancel);
    form.append(this.make("p", "mute", t("config.operator.unlockHint")), label, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const token = input.value; input.value = "";
      if (token !== "") void this.unlock(token);
    });
    return form;
  }

  private async unlock(token: string): Promise<void> {
    const { t } = this.ports;
    this.busy(true);
    const result = await this.ports.elevate(token).catch(() => null);
    this.busy(false);
    if (result === null) { this.say({ text: t("config.launch.err.network"), ok: false }); return; }
    if (!result.ok) {
      this.say({ ok: false, text: result.error === "too-many-attempts" ? t("config.launch.err.tooMany", { seconds: result.retryAfter ?? 0 })
        : result.error === "wrong-token" ? t("config.launch.err.wrongToken") : t("config.launch.err.generic", { message: result.error }) });
      return;
    }
    this.token.hidden = true;
    await this.submit();
  }

  private async submit(): Promise<void> {
    const { t } = this.ports;
    const problem = operatorNameProblem(this.input.value);
    if (problem !== null) { this.say({ text: t(`config.operator.err.${problem}`, { max: OPERATOR_NAME_MAX }), ok: false }); return; }
    this.busy(true);
    const result = await this.ports.saveSettings({ operator_name: this.input.value.trim() }).catch(() => null);
    this.busy(false);
    if (result === null) { this.say({ text: t("config.launch.err.network"), ok: false }); return; }
    if (!result.ok && result.error === "elevation-required") {
      this.token.hidden = false; this.say(null);
      this.token.querySelector("input")?.focus();
      return;
    }
    if (!result.ok) {
      this.say({ text: result.error === "invalid" ? t("config.operator.err.invalid") : t("config.launch.err.generic", { message: result.error }), ok: false });
      return;
    }
    const name = cleanOperatorName(operatorNameOfConfig(result.value));
    this.input.value = name;
    this.say({ text: t(name === "" ? "config.operator.cleared" : "config.operator.saved"), ok: true });
    this.doc.defaultView?.dispatchEvent(new CustomEvent(OPERATOR_NAME_EVENT, { detail: name }));
  }
}
