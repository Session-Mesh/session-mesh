// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The local mesh's entry point: starts the interface (static/app.js) and wires the two
// sign-out buttons, which only a local mesh has. Kept out of index.html so the page's
// Content-Security-Policy (server.py, INDEX_CSP) can refuse every inline script.
const localMesh = MeshUI.startLocalMesh();
for (const [id, path, ask] of [["btn-logout", "/api/logout", null],
    ["btn-logout-all", "/api/logout-all", () => MeshI18n.t("logout.allConfirm")]])
  document.getElementById(id).addEventListener("click", async () => {
    if (!localMeshEffectsAllowed()) return;
    if (ask && !confirm(ask())) return;
    try { await requestLocal(path, {method: "POST"}); } catch {}
    if (!localMeshEffectsAllowed()) return;
    location.href = "/login";
  });
