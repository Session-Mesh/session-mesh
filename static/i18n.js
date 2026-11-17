// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

"use strict";

// Interface strings. Each language is one catalog, /static/i18n/<code>.json, a
// flat object of keys; /static/i18n/languages.json names the catalogs offered
// in the settings. Adding a language is adding its catalog and its line there.
//
// The language is the one forced in the settings (kept in this browser), else
// the first of navigator.languages that has a catalog, else English. A key
// missing from a catalog falls back to English. A value is a string with {name}
// placeholders, or a plural object ({ "one": ..., "other": ... }) chosen by the
// numeric parameter `n`.
//
// The login page and the service worker cannot fetch the catalogs on their own
// (the login page is served before authentication), so each load also mirrors
// the chosen language and its catalog into the Cache API ("mesh-i18n").
(function install(root) {
  const FALLBACK = "en";
  const PREFERENCE_KEY = "mesh.lang";
  const MIRROR_CACHE = "mesh-i18n";
  const MIRROR_CATALOG = "/__mesh-i18n/catalog";
  const BASE = "/static/i18n/";
  const has = (object, key) => object !== null && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, key);

  function resolveLanguage(preference, browserLanguages, available) {
    if (preference && has(available, preference)) return preference;
    for (const tag of browserLanguages || []) {
      const lower = String(tag || "").toLowerCase();
      if (has(available, lower)) return lower;
      const base = lower.split("-")[0];
      if (has(available, base)) return base;
    }
    return FALLBACK;
  }

  function format(template, params) {
    if (!params) return template;
    return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name) => (has(params, name) && params[name] !== undefined && params[name] !== null ? String(params[name]) : whole));
  }

  function choosePlural(value, params, lang) {
    if (typeof value === "string") return value;
    if (value === null || typeof value !== "object") return undefined;
    let category = "other";
    try { category = new Intl.PluralRules(lang).select(Number(params?.n)); } catch {}
    const chosen = has(value, category) ? value[category] : value.other;
    return typeof chosen === "string" ? chosen : undefined;
  }

  // The text of a key in one catalog or its English fallback, undefined when
  // neither has it.
  function createLookup({ lang, catalog, fallback }) {
    return function lookup(key, params) {
      let text = has(catalog, key) ? choosePlural(catalog[key], params, lang) : undefined;
      if (text === undefined && has(fallback, key)) text = choosePlural(fallback[key], params, FALLBACK);
      return text === undefined ? undefined : format(text, params);
    };
  }

  // A translator over one catalog and its English fallback. `onMissing` hears
  // about a key absent from both (a bug the coverage test is there to catch);
  // the key itself is then returned.
  function createTranslator({ lang, catalog, fallback, onMissing }) {
    const lookup = createLookup({ lang, catalog, fallback });
    return function translate(key, params) {
      const text = lookup(key, params);
      if (text !== undefined) return text;
      onMissing?.(key);
      return key;
    };
  }

  // Server answers are still prose in the server's language: a table of
  // patterns (/static/i18n/server-messages.json) turns the known ones into keys,
  // their named groups into parameters. An unknown message is shown as it came.
  function compileServerMessages(rows) {
    const compiled = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row.pattern !== "string" || typeof row.key !== "string") continue;
      try { compiled.push({ re: new RegExp(row.pattern, "s"), key: row.key }); } catch {}
    }
    return compiled;
  }

  function translateServerMessage(compiled, translate, text) {
    const raw = String(text ?? "");
    const trimmed = raw.trim();
    for (const { re, key } of compiled) {
      const match = re.exec(trimmed);
      if (match) return translate(key, { ...(match.groups || {}) });
    }
    return raw;
  }

  const ATTRIBUTES = ["title", "placeholder", "aria-label", "alt", "label"];
  const SELECTOR = ["[data-i18n]", ...ATTRIBUTES.map((name) => `[data-i18n-${name}]`)].join(",");

  // Static markup carries its English text inline (shown until the catalogs are
  // loaded) and names its keys: data-i18n for the text, data-i18n-<attribute>
  // for title, placeholder, aria-label, alt and label. A key that no loaded
  // catalog has leaves the inline English in place (`lookup` returns undefined).
  function applyDom(rootNode, lookup) {
    if (!rootNode?.querySelectorAll) return;
    for (const element of rootNode.querySelectorAll(SELECTOR)) {
      const text = element.dataset.i18n ? lookup(element.dataset.i18n) : undefined;
      if (text !== undefined) element.textContent = text;
      for (const name of ATTRIBUTES) {
        const key = element.getAttribute(`data-i18n-${name}`);
        const value = key ? lookup(key) : undefined;
        if (value !== undefined) element.setAttribute(name, value);
      }
    }
    for (const template of rootNode.querySelectorAll("template")) applyDom(template.content, lookup);
  }

  function readPreference(storage) {
    try {
      const raw = storage?.getItem(PREFERENCE_KEY);
      const value = raw === null || raw === undefined ? null : JSON.parse(raw);
      return typeof value === "string" && value ? value : null;
    } catch { return null; }
  }

  function writePreference(storage, code) {
    try {
      if (code) storage?.setItem(PREFERENCE_KEY, JSON.stringify(code));
      else storage?.removeItem(PREFERENCE_KEY);
    } catch {}
  }

  // The browser runtime, in parts: the catalog fetcher, the browser's language
  // list, the Cache API mirror, one load of the catalogs, and the shared state.
  function createFetcher(env) {
    const version = () => {
      try { return env.document?.querySelector('meta[name="client-version"]')?.content || ""; } catch { return ""; }
    };
    async function fetchJson(name) {
      if (typeof env.fetch !== "function") return null;
      const stamp = version();
      try {
        const response = await env.fetch(`${BASE}${name}${stamp && !stamp.startsWith("__") ? `?v=${encodeURIComponent(stamp)}` : ""}`,
          { cache: "no-cache", credentials: "same-origin" });
        if (!response.ok) return null;
        return await response.json();
      } catch { return null; }
    }
    // The English catalog backs every other: a failed fetch is tried once more.
    const fetchFallback = async () => (await fetchJson(`${FALLBACK}.json`)) ?? fetchJson(`${FALLBACK}.json`);
    return { fetchJson, fetchFallback };
  }

  function browserLanguages(env) {
    const nav = env.navigator || {};
    if (Array.isArray(nav.languages) && nav.languages.length) return nav.languages;
    return nav.language ? [nav.language] : [];
  }

  async function mirror(env, state) {
    const store = env.caches;
    if (!store?.open || typeof env.Response !== "function") return;
    try {
      const cache = await store.open(MIRROR_CACHE);
      await cache.put(MIRROR_CATALOG, new env.Response(JSON.stringify({ lang: state.lang, strings: { ...state.fallback, ...state.catalog } }),
        { headers: { "Content-Type": "application/json" } }));
    } catch {}
  }

  const asObject = (value) => (value && typeof value === "object" ? value : {});

  // Fetches the offered languages, then the catalogs of the chosen one, into `state`.
  async function loadCatalogs(env, fetcher, state) {
    const offered = await fetcher.fetchJson("languages.json");
    state.languages = offered && typeof offered === "object" && has(offered, FALLBACK) ? offered : { [FALLBACK]: "English" };
    state.lang = resolveLanguage(readPreference(env.storage), browserLanguages(env), state.languages);
    const [fallback, catalog, server] = await Promise.all([
      fetcher.fetchFallback(),
      state.lang === FALLBACK ? Promise.resolve(null) : fetcher.fetchJson(`${state.lang}.json`),
      fetcher.fetchJson("server-messages.json"),
    ]);
    state.fallback = asObject(fallback);
    state.catalog = state.lang === FALLBACK ? state.fallback : asObject(catalog);
    state.server = compileServerMessages(server);
  }

  function createRuntime(env) {
    const state = { lang: FALLBACK, languages: { [FALLBACK]: "English" }, catalog: {}, fallback: {}, server: [], loaded: false };
    const fetcher = createFetcher(env);
    const missing = new Set();
    const warnMissing = (key) => {
      if (missing.has(key)) return;
      missing.add(key);
      env.console?.warn?.(`i18n: no text for key ${key}`);
    };
    let lookup = createLookup({ lang: FALLBACK, catalog: {}, fallback: {} });
    let translate = createTranslator({ lang: FALLBACK, catalog: {}, fallback: {} });

    async function load() {
      await loadCatalogs(env, fetcher, state);
      const sources = { lang: state.lang, catalog: state.catalog, fallback: state.fallback };
      lookup = createLookup(sources);
      translate = createTranslator({ ...sources, onMissing: warnMissing });
      state.loaded = true;
      if (env.document?.documentElement) env.document.documentElement.lang = state.lang;
      applyDom(env.document, lookup);
      await mirror(env, state);
      return state.lang;
    }

    let ready = load();
    return Object.freeze({
      get ready() { return ready; },
      get lang() { return state.lang; },
      get languages() { return { ...state.languages }; },
      get loaded() { return state.loaded; },
      preference: () => readPreference(env.storage),
      t(key, params) {
        if (!state.loaded) env.console?.warn?.(`i18n: ${key} read before the catalogs were loaded`);
        return translate(key, params);
      },
      // A locale for Intl and toLocale*: the interface language.
      locale: () => state.lang,
      serverMessage: (text) => translateServerMessage(state.server, translate, text),
      applyDom: (rootNode) => applyDom(rootNode, lookup),
      // Force a language (null: follow the browser again), then reload the
      // catalogs and the static markup. The caller re-renders what it built.
      use(code) {
        writePreference(env.storage, code && has(state.languages, code) ? code : null);
        ready = load();
        return ready;
      },
    });
  }

  const core = Object.freeze({ resolveLanguage, format, createLookup, createTranslator, compileServerMessages, translateServerMessage, applyDom, createRuntime, PREFERENCE_KEY, MIRROR_CACHE, MIRROR_CATALOG });
  let runtime = null;
  if (root.document) {
    let storage = null;
    try { storage = root.localStorage; } catch {}
    runtime = createRuntime({
      document: root.document, navigator: root.navigator, fetch: root.fetch?.bind(root), storage,
      caches: (() => { try { return root.caches; } catch { return undefined; } })(), Response: root.Response, console: root.console,
    });
  }
  root.MeshI18n = runtime ? Object.freeze(Object.assign(Object.create(runtime), { core })) : Object.freeze({ core });
})(globalThis);
