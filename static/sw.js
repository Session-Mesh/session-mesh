// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// session-mesh's service worker. It makes the mesh installable as an app; it
// keeps no offline copy (without its server the mesh has nothing to show).
// Served from / (server.py) so that its scope is the whole mesh. Keep the /sw.js
// route for good: an installed worker is only replaced or removed through it (to
// retire it, serve a version that calls self.registration.unregister()). Public:
// never put a secret here.

self.addEventListener("install", () => self.skipWaiting());

// Interface text: the catalog of the chosen language, mirrored into the Cache
// API by the page (static/i18n.js); English when the page never mirrored one.
const ENGLISH = { "sw.replyNotSent": "Reply not sent", "sw.unreachable": "mesh unreachable: {error}" };
async function translate(key, params = {}) {
  let strings = {};
  try {
    const hit = await (await caches.open("mesh-i18n")).match("/__mesh-i18n/catalog");
    if (hit) strings = (await hit.json()).strings || {};
  } catch {}
  const template = typeof strings[key] === "string" ? strings[key] : ENGLISH[key];
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// A push from the mesh (webpush.py): an agent waits for the owner or has finished.
// Not shown while a mesh window is in front of them: they already see it there.
self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (m.id && wins.some((w) => w.focused && w.visibilityState === "visible")) return;
    await self.registration.showNotification(m.title || "Session Mesh", {
      body: m.body || "", tag: m.id || "mesh", renotify: true, icon: "/static/icons/icon-192.png?v=6f13fb609ae0fc2c",
      data: { id: m.id || "", token: m.token || "" },
      actions: Array.isArray(m.actions) ? m.actions.slice(0, 2) : [],   // a claude question's first choices
    });
  })());
});

// A tap opens the mesh on that session: in a mesh window already open, or a new one.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data?.id || "";
  const token = e.notification.data?.token;
  // a choice button: answered by the server, without opening the mesh; on failure
  // (question changed, expired) a notification says so and a tap opens the session
  if (e.action && token) {
    e.waitUntil((async () => {
      let msg;
      try {
        const r = await fetch("/api/push/act", { method: "POST", headers: { "Content-Type": "application/json" },
                                                 body: JSON.stringify({ token, action: e.action }) });
        if (r.ok) return;
        msg = await r.text();
      } catch (err) { msg = await translate("sw.unreachable", { error: err.message }); }
      await self.registration.showNotification(await translate("sw.replyNotSent"), { body: msg, tag: id || "mesh", data: { id } });
    })());
    return;
  }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).pathname === "/");
    if (win) {
      await win.focus();
      if (id) win.postMessage({ type: "open", id });
      return;
    }
    await self.clients.openWindow(id ? `/?open=${encodeURIComponent(id)}` : "/");
  })());
});

// The browser renewed the subscription (keys rotated, expiry): hand the new one
// to the server, or notifications would stop without a word.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const k = await (await fetch("/api/push/key")).json();
    if (!k.available) return;
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k.key });
    await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" },
                                         body: JSON.stringify({ subscription: sub.toJSON() }) });
  })());
});
