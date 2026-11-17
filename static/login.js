// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The sign-in page's script, outside login.html so that page's Content-Security-Policy
// (server.py, LOGIN_CSP) can refuse every inline script. Public (server.py, PUBLIC): no secret.
if (location.search.includes("bad")) document.getElementById("bad").style.display = "block";
// Served before authentication, this page cannot fetch the catalogs: it uses the
// language and catalog the interface last mirrored into the Cache API (static/i18n.js).
(async () => {
  try {
    const hit = await (await caches.open("mesh-i18n")).match("/__mesh-i18n/catalog");
    if (!hit) return;
    const { lang, strings } = await hit.json();
    const text = (key) => (typeof strings?.[key] === "string" ? strings[key] : null);
    for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = text(el.dataset.i18n) ?? el.textContent;
    for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = text(el.dataset.i18nPlaceholder) ?? el.placeholder;
    if (typeof lang === "string") document.documentElement.lang = lang;
  } catch {}
})();
