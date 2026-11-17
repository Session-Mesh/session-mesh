// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, languages, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import "./board-local.css";
import { installFreeFonts } from "./board-fonts.mjs";
// The interface catalogs runtime (globalThis.MeshI18n). It is bundled here
// rather than loaded by board.html, which tools/build-board.mjs regenerates.
import "./i18n.js";

const t = (key, params) => globalThis.MeshI18n.t(key, params);
// A server answer is still prose in the server's language: translated when known.
const serverText = (text) => globalThis.MeshI18n.serverMessage(text);
const detail = (error) => (error?.message ? serverText(error.message) : "");

// Excalidraw's own interface follows the language MeshI18n chose ("fr" gives its
// "fr-FR" locale, shipped in excalidraw-assets/locales/). Without langCode it stays
// in English and sets <html lang> to "en".
function excalidrawLanguage(lang) {
  const base = String(lang || "en").toLowerCase().split("-")[0];
  const exact = languages.find((language) => language.code.toLowerCase() === String(lang).toLowerCase());
  const sameBase = languages.find((language) => language.code.toLowerCase().split("-")[0] === base);
  return (exact ?? sameBase)?.code ?? "en";
}

installFreeFonts();

// Excalidraw requests its on-demand chunk (the Mermaid dialog, image resizing,
// file dialogs) as soon as it loads. That chunk is not shipped (it embeds elkjs,
// EPL-2.0: static/vendor/THIRD_PARTY.md) and this board offers none of those
// features, so the failed load is expected and not reported as an error.
const OMITTED_CHUNK = /^Loading chunk 4736 failed\./;
window.addEventListener("unhandledrejection", (event) => {
  if (event.reason?.name === "ChunkLoadError" && OMITTED_CHUNK.test(event.reason.message)) event.preventDefault();
});

const empty = () => ({ elements: [], appState: {}, files: {}, version: 0 });
const session = new URLSearchParams(location.search).get("session");
const endpoint = session ? `/api/board/${encodeURIComponent(session)}` : null;

function validDocument(value) {
  return value && Array.isArray(value.elements) && value.appState && typeof value.appState === "object"
    && value.files && typeof value.files === "object" && Number.isInteger(value.version);
}

// What Excalidraw would write for this scene.  Comparing like with like keeps
// a render or a selection (which serialize to the same scene) from being sent
// as a new revision, and with it a new version an agent has to race.
function sceneKey(elements, appState) {
  return JSON.stringify([elements, appState]);
}

// appState entries that are set while a stroke, a resize or a text edit is under way.
const IN_PROGRESS = ["newElement", "editingElement", "editingLinearElement", "resizingElement", "draggingElement", "editingTextElement"];

function loadedSceneKey(document) {
  const restored = restore(document, null, null);
  const serialized = JSON.parse(serializeAsJSON(restored.elements, restored.appState, {}, "database"));
  return sceneKey(serialized.elements, serialized.appState);
}

function App() {
  const api = useRef(null);
  const current = useRef(empty());
  const knownScene = useRef(null);
  const pending = useRef(null);
  const saving = useRef(false);
  const conflicted = useRef(false);
  const hydrated = useRef(false);
  const ignoreInitialChange = useRef(true);
  const suppressProgrammaticChange = useRef(false);
  const timer = useRef(0);
  const localGeneration = useRef(0);
  const [status, setStatus] = useState(() => (session ? t("common.loading") : t("board.unavailable")));
  const [ready, setReady] = useState(false);
  const [mount] = useState(0);
  const [hasConflict, setHasConflict] = useState(false);
  const [hasRefreshOffer, setHasRefreshOffer] = useState(false);

  const save = useCallback(async () => {
    if (!endpoint || conflicted.current || saving.current || !pending.current) return;
    const document = { ...pending.current, version: current.current.version };
    const previousScene = knownScene.current;
    knownScene.current = sceneKey(document.elements, document.appState);
    pending.current = null;
    saving.current = true;
    if (!endpoint) return;
    setStatus(t("board.saving"));
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(document),
      });
      if (response.status === 409) {
        // Do not retry with the same stale scene.  A remote MCP replacement
        // must never be silently overwritten by an open browser pane.
        pending.current = null;
        knownScene.current = previousScene;
        clearTimeout(timer.current);
        conflicted.current = true;
        setHasConflict(true);
        setStatus(t("board.conflictStatus"));
        return;
      }
      if (!response.ok) throw new Error(await response.text());
      const saved = await response.json();
      current.current = { ...document, version: saved.version };
      setStatus(t("board.saved"));
    } catch (error) {
      knownScene.current = previousScene;  // not stored: the next change must try again
      setStatus(detail(error) ? t("board.saveFailedDetail", { detail: detail(error) }) : t("board.saveFailed"));
    } finally {
      saving.current = false;
      // A draw made while the request was in flight is saved using the version
      // just acknowledged above. Only the latest scene is retained.
      if (!conflicted.current && pending.current) save();
    }
  }, []);

  // True when replacing the scene would lose something the server does not hold:
  // a write in flight or queued, a rejected stale scene, a stroke or text edit in
  // progress, or a drawing that differs from the last scene the server has.
  const localChangesAtRisk = useCallback(() => {
    const excalidraw = api.current;
    if (!excalidraw || !hydrated.current || conflicted.current || saving.current || pending.current) return true;
    const state = excalidraw.getAppState();
    if (state.cursorButton === "down" || IN_PROGRESS.some((key) => state[key])) return true;
    const serialized = JSON.parse(serializeAsJSON(excalidraw.getSceneElements(), state, {}, "database"));
    return sceneKey(serialized.elements, serialized.appState) !== knownScene.current;
  }, []);

  // `options.onlyIfClean` is the agent-triggered path: it re-checks after the
  // fetch, since a stroke may have started meanwhile, and offers instead of replacing.
  const reloadRemote = useCallback(async (options) => {
    const onlyIfClean = options?.onlyIfClean === true;
    if (!endpoint || saving.current) return;
    if (!onlyIfClean) setStatus(t("board.reloading"));
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error(await response.text());
      const document = await response.json();
      if (!validDocument(document)) throw new Error(t("board.invalidDocument"));
      if (onlyIfClean && localChangesAtRisk()) {
        setHasRefreshOffer(true);
        return;
      }
      // Cancel first: a pre-existing debounce must not write the human's
      // discarded local scene after they explicitly accepted this reload.
      localGeneration.current += 1;
      clearTimeout(timer.current);
      pending.current = null;
      current.current = document;
      knownScene.current = loadedSceneKey(document);
      conflicted.current = false;
      setHasConflict(false);
      setHasRefreshOffer(false);
      // Update the already-mounted scene.  Recreating Excalidraw can emit an
      // empty bootstrap change after its guard has opened; that is neither a
      // human edit nor a reason to write a second revision.
      const restored = restore(document, null, null);
      suppressProgrammaticChange.current = true;
      api.current?.updateScene({ elements: restored.elements, appState: restored.appState });
      setStatus(onlyIfClean ? t("board.updatedByAgent") : t("board.saved"));
    } catch (error) {
      setStatus(detail(error) ? t("board.reloadFailedDetail", { detail: detail(error) }) : t("board.reloadFailed"));
    }
  }, [localChangesAtRisk]);

  useEffect(() => {
    const receive = (event) => {
      if (event.origin !== location.origin || !event.data || event.data.type !== "mesh-board-refresh-offer") return;
      // An agent changed this board.  With nothing local to lose the pane
      // refreshes by itself; otherwise the request stays an offer that never
      // mutates the canvas and remains visible until the person accepts or refuses.
      if (localChangesAtRisk()) {
        setHasRefreshOffer(true);
        return;
      }
      reloadRemote({ onlyIfClean: true });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [localChangesAtRisk, reloadRemote]);

  useEffect(() => {
    if (!endpoint) return undefined;
    let cancelled = false;
    fetch(endpoint, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      })
      .then((document) => {
        if (cancelled || !validDocument(document)) return;
        current.current = document;
        knownScene.current = loadedSceneKey(document);
        // Mount only after this value is known: mounting an empty scene and
        // replacing it later can make Excalidraw emit a delayed empty change.
        // `initialData` below is the restored server scene.
        setReady(true);
        hydrated.current = true;
        setStatus(t("board.saved"));
      })
      .catch((error) => !cancelled && setStatus(detail(error) ? t("board.loadFailedDetail", { detail: detail(error) }) : t("board.loadFailed")));
    return () => { cancelled = true; clearTimeout(timer.current); };
  }, []);

  const onChange = useCallback((elements, appState, files) => {
    if (!hydrated.current || !endpoint || conflicted.current) return;
    // Excalidraw emits one bookkeeping onChange as it mounts. It is not an
    // owner edit and, on a remount, can still contain its empty bootstrap.
    if (ignoreInitialChange.current || suppressProgrammaticChange.current) {
      ignoreInitialChange.current = false;
      suppressProgrammaticChange.current = false;
      return;
    }
    // This first version deliberately has no file/image persistence. The server is
    // authoritative too, but refuse to queue a write it will reject.
    if (Object.keys(files || {}).length || elements.some((element) => element.type === "image")) {
      setStatus(t("board.filesUnsupported"));
      return;
    }
    const serialized = JSON.parse(serializeAsJSON(elements, appState, {}, "database"));
    const next = { elements: serialized.elements, appState: serialized.appState, files: {}, version: current.current.version };
    clearTimeout(timer.current);
    if (sceneKey(next.elements, next.appState) === knownScene.current) {
      // Same scene as the server holds (or is receiving): also drop a queued
      // write of a scene the person has since undone back to this one.
      pending.current = null;
      return;
    }
    const generation = localGeneration.current;
    timer.current = setTimeout(() => {
      if (generation !== localGeneration.current || conflicted.current) return;
      pending.current = next;
      save();
    }, 550);
  }, [ready, save]);

  const initialData = useMemo(() => {
    const restored = restore(current.current, null, null);
    return { elements: restored.elements, appState: restored.appState, files: {} };
  }, [ready, mount]);
  return React.createElement("main", { className: "board-shell" },
    React.createElement("div", { className: "board-status", role: "status" }, status),
    hasConflict && React.createElement("div", { className: "board-conflict", role: "alert" },
      React.createElement("span", null, t("board.conflictMessage")),
      React.createElement("button", { type: "button", onClick: reloadRemote }, t("board.reloadRemote")),
    ),
    hasRefreshOffer && !hasConflict && React.createElement("div", { className: "board-conflict", role: "alert" },
      React.createElement("span", null, t("board.refreshOffer")),
      React.createElement("button", { type: "button", onClick: reloadRemote }, t("board.reloadRemote")),
      React.createElement("button", { type: "button", onClick: () => setHasRefreshOffer(false) }, t("board.keepDrawing")),
    ),
    ready && React.createElement(Excalidraw, {
      key: mount,
      excalidrawAPI: (value) => {
        api.current = value;
        if (ready) {
          value.updateScene({ elements: current.current.elements, appState: current.current.appState });
          setTimeout(() => { ignoreInitialChange.current = false; }, 0);
        }
      },
      initialData,
      onChange,
      UIOptions: { canvasActions: { changeViewBackgroundColor: true, clearCanvas: true, export: false, loadScene: false, saveToActiveFile: false, theme: true },
        // Images are not stored by this board, and the image resizer lives in the
        // Excalidraw chunk that is not shipped (static/vendor/THIRD_PARTY.md).
        tools: { image: false } },
      langCode: excalidrawLanguage(globalThis.MeshI18n.lang),
      zenModeEnabled: false,
      gridModeEnabled: false,
      viewModeEnabled: false,
    }),
  );
}

// First render once the catalogs are loaded (load() always settles).
globalThis.MeshI18n.ready.finally(() => {
  createRoot(document.getElementById("root")).render(React.createElement(App));
});
