// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The sign-in page's script, outside login.html so that page's Content-Security-Policy
// (server.py, LOGIN_CSP) can refuse every inline script. Public (server.py, PUBLIC): no secret.
if (location.search.includes("bad")) document.getElementById("bad").style.display = "block";
// The recent folders an older version kept in this browser (the runner keeps them now, see static/app.js,
// moveRecentFoldersToRunner): a browser signed out, or revoked by "log out everywhere", keeps no copy of the paths.
try { localStorage.removeItem("mesh.recentFolders"); } catch {}
// The Projects view's place and unsent answer drafts of this tab (static/work-view-state.ts, STATE_KEY): a tab that
// reaches the sign-in page (signed out, token refused) keeps none of them.
try { sessionStorage.removeItem("mesh.workView"); } catch {}
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
