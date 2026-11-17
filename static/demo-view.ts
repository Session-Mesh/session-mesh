// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {type MeshView, exact, legacySceneText, parseJsonStrict, readView,
  readViewWithinBudget, renderView, scalarText} from "./demo-view-contract";

type Choice = { label: string; target: string };
type State = { id: string; view: MeshView; choices: Choice[] };
export type Scene = {
  format: "mesh-scene-v1" | "mesh-scene-v2"; version: number; title: string;
  theme: "dark" | "light"; initial: string; states: State[];
};

const shortId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value);
const nonblank = (value: unknown, strict: boolean): value is string => {
  if (!(strict ? scalarText(value, 120) : legacySceneText(value, 120))) return false;
  return Array.from(value as string).some((char) => !/^\p{White_Space}$/u.test(char));
};

export function readScene(value: unknown): Scene | null {
  if (!exact(value, ["format", "version", "title", "theme", "initial", "states"])
      || (value.format !== "mesh-scene-v1" && value.format !== "mesh-scene-v2")
      || !Number.isSafeInteger(value.version) || Number(value.version) < 0
      || !(value.format === "mesh-scene-v1" ? legacySceneText(value.title, 120) : scalarText(value.title, 120))
      || (value.theme !== "dark" && value.theme !== "light")
      || !shortId(value.initial) || !Array.isArray(value.states)
      || value.states.length < 1 || value.states.length > 16) return null;
  const expectedView = value.format === "mesh-scene-v1" ? "mesh-view-v1" : "mesh-view-v2";
  let choices = 0;
  const nodeCount = {value: 0};
  const ids = new Set<string>();
  const states: State[] = [];
  for (const raw of value.states) {
    if (!exact(raw, ["id", "view", "choices"]) || !shortId(raw.id) || ids.has(raw.id)
        || !Array.isArray(raw.choices)) return null;
    const view = readViewWithinBudget(raw.view, expectedView, nodeCount);
    if (!view) return null;
    const stateChoices: Choice[] = [];
    for (const candidate of raw.choices) {
      if (!exact(candidate, ["label", "target"]) || !nonblank(candidate.label, value.format === "mesh-scene-v2")
          || !shortId(candidate.target)) return null;
      stateChoices.push({label: candidate.label, target: candidate.target});
    }
    choices += stateChoices.length;
    if (choices > 32) return null;
    ids.add(raw.id);
    states.push({id: raw.id, view, choices: stateChoices});
  }
  if (!ids.has(value.initial as string)
      || states.some((state) => state.choices.some((choice) => !ids.has(choice.target)))) return null;
  return value as unknown as Scene;
}

const element = <K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const result = doc.createElement(tag);
  if (className) result.className = className;
  return result;
};

// The labels below stay in English on purpose: the scene runs in a sandboxed frame with no
// access to the interface's language catalogs (static/i18n/). See docs/features.md.
export function mountScene(root: HTMLElement, scene: Scene): void {
  const doc = root.ownerDocument;
  doc.body.className = scene.theme;
  let current = scene.initial;
  const render = (focus: boolean): void => {
    const state = scene.states.find((candidate) => candidate.id === current);
    if (!state) return;
    const fragment = doc.createDocumentFragment();
    const header = element(doc, "header"); header.textContent = `Interactive demo · revision ${scene.version}`;
    const title = element(doc, "h1"); title.textContent = scene.title;
    const stateView = element(doc, "section", "state-view"); stateView.setAttribute("aria-live", "polite");
    renderView(stateView, state.view);
    const actions = element(doc, "nav", "choices"); actions.setAttribute("aria-label", "Demo choices");
    for (const choice of state.choices) {
      const button = element(doc, "button"); button.type = "button"; button.textContent = choice.label;
      button.addEventListener("click", () => { current = choice.target; render(true); }); actions.append(button);
    }
    fragment.append(header, title, stateView, actions); root.replaceChildren(fragment);
    if (focus) {
      const focusTarget = stateView.querySelector<HTMLElement>("h2") ?? stateView;
      focusTarget.tabIndex = -1; focusTarget.focus({preventScroll: true});
    }
  };
  render(false);
}

function boot(): void {
  const root = document.getElementById("mesh-demo-root");
  const encoded = document.body.dataset.meshScene;
  if (!root || !encoded) return;
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const source = new TextDecoder("utf-8", {fatal: true}).decode(bytes);
    const scene = readScene(parseJsonStrict(source));
    if (!scene) throw new Error("invalid scene");
    mountScene(root, scene);
  } catch {
    root.textContent = "Invalid demo scene.";
  }
}

if (typeof document !== "undefined") boot();
export {decodeView, readView, renderView} from "./demo-view-contract";
