// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Pi extension: accept only content-free wake notices. Message bodies and
// consent remain behind Mesh's existing session-scoped MCP tools.
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const token = process.env.MESH_SESSION_TOKEN;
const port = Number(process.env.MESH_PORT || "7690");
const prefix = "[Mesh notification ";
const MAX_PENDING = 256;
const RETRY_MS = 10000;
const MAX_LINE = 65536;
// The requests carry the session token to 127.0.0.1: never through a proxy. With NODE_USE_ENV_PROXY=1
// or --use-env-proxy, Node routes its global agent through HTTP_PROXY; an agent given an empty proxyEnv
// connects directly (older Node ignores the option and has no environment proxy at all).
const direct = new http.Agent({ proxyEnv: {} });

async function persisted(manager, marker, state) {
  const filename = manager.getSessionFile();
  if (!filename) return false;
  const matching = new Set(manager.getBranch().filter(entry => {
    if (entry.type !== "message" || entry.message?.role !== "user") return false;
    const content = entry.message.content;
    return typeof content === "string" ? content.includes(marker) :
      Array.isArray(content) && content.some(part => part.type === "text" && part.text?.includes(marker));
  }).map(entry => entry.id));
  if (!matching.size) return false;
  try {
    const info = await stat(filename);
    if (state.file !== filename || state.device !== info.dev || state.inode !== info.ino ||
        state.offset > info.size) state.offset = 0;
    const stream = createReadStream(filename, { start: state.offset, encoding: "utf8", highWaterMark: MAX_LINE });
    let line = "", skipping = false;
    for await (const chunk of stream) {
      for (const part of chunk.split(/(?<=\n)/)) {
        const ended = part.endsWith("\n");
        if (!skipping) {
          if (line.length + part.length > MAX_LINE) { skipping = true; line = ""; }
          else line += part;
        }
        if (ended) {
          if (!skipping && line.includes(marker)) {
            const entry = JSON.parse(line);
            if (entry.type === "message" && matching.has(entry.id)) {
              stream.destroy();
              return true;
            }
          }
          line = "";
          skipping = false;
        }
      }
    }
  } catch { /* not persisted yet, or transient read error */ }
  return false;
}

export default function (pi) {
  let stopped = false;
  let connection;
  let timer;
  let ctx;
  let backoff = 1000;
  const pending = new Map();
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) return;

  function ack(id) {
    const state = pending.get(id);
    if (!state || state.ack) return;
    const body = JSON.stringify({ notification_id: id });
    const req = http.request({ host: "127.0.0.1", port, agent: direct, method: "POST",
      path: "/api/agent-mail/@self/pi-wake-ack",
      headers: { Authorization: `MeshSession ${token}`, "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body) } }, res => {
      res.resume();
      if (res.statusCode === 200 || res.statusCode === 409) pending.delete(id);
    });
    state.ack = req;
    req.setTimeout(5000, () => req.destroy());
    req.on("error", () => {});
    req.on("close", () => { if (state.ack === req) state.ack = undefined; });
    req.end(body);
  }

  async function confirm(id) {
    if (!ctx || stopped || !pending.has(id)) return;
    const state = pending.get(id);
    if (await persisted(ctx.sessionManager, `${prefix}${id}]`, state)) ack(id);
  }

  async function deliver(notice) {
    const id = notice.notification_id;
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id) ||
        !Number.isSafeInteger(notice.count) || notice.count < 1 || notice.count > 9999) return;
    const marker = `${prefix}${id}]`;
    let state = pending.get(id);
    if (!state) {
      // A wake can be cancelled while Pi is busy. Evict the oldest local
      // bookkeeping rather than let cancelled IDs block new notifications.
      // Mesh remains authoritative; a repeated wake keeps the same ID.
      if (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        pending.get(oldest).ack?.destroy();
        pending.delete(oldest);
      }
      state = { offset: 0, file: null, device: null, inode: null, lastAttempt: 0, checking: false };
      pending.set(id, state);
    }
    if (state.checking) return;
    state.checking = true;
    try {
      if (await persisted(ctx.sessionManager, marker, state)) { ack(id); return; }
      // Pi's extension API does not report asynchronous send errors. Retry only
      // when Pi is idle and has no queued input. The stable marker makes a rare
      // duplicate identifiable if another extension stalls its input hook.
      if (state.lastAttempt && (Date.now() - state.lastAttempt < RETRY_MS ||
          !ctx.isIdle() || ctx.hasPendingMessages())) return;
      if (!state.lastAttempt) {
        try {
          state.file = ctx.sessionManager.getSessionFile();
          const info = await stat(state.file);
          state.offset = info.size;
          state.device = info.dev;
          state.inode = info.ino;
        } catch { state.offset = 0; }
      }
      state.lastAttempt = Date.now();
      pi.sendUserMessage(`${marker} ${notice.count} Mesh message(s) waiting; check ` +
        "mail.inbox and ask yes/no/always before reading. A repeated notification " +
        "with the same identifier refers to the same messages.", { deliverAs: "steer" });
    } finally { state.checking = false; }
  }

  function connect() {
    if (stopped) return;
    const req = http.get({ host: "127.0.0.1", port, agent: direct, path: "/api/agent-mail/@self/pi-wakes",
      headers: { Authorization: `MeshSession ${token}` } }, res => {
      if (res.statusCode !== 200) { res.resume(); return; }
      backoff = 1000;
      let buffer = "";
      res.setEncoding("utf8");
      res.on("error", () => req.destroy());
      res.on("data", chunk => {
        buffer += chunk;
        if (buffer.length > 1024) { req.destroy(); return; }
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try { const notice = JSON.parse(line); if (notice.notification_id) void deliver(notice).catch(() => {}); }
          catch { req.destroy(); return; }
        }
      });
    });
    connection = req;
    // Server heartbeat is 15 s; reconnect if an otherwise open socket stalls.
    req.setTimeout(45000, () => req.destroy());
    const retry = () => {
      if (!stopped && !timer) {
        timer = setTimeout(() => { timer = undefined; connect(); }, backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    };
    req.on("error", retry);
    req.on("close", retry);
  }

  pi.on("session_start", (_event, context) => {
    ctx = context;
    stopped = false;
    // Without a session file no durable confirmation is possible.
    if (ctx.sessionManager.getSessionFile()) connect();
  });
  pi.on("message_end", event => {
    if (event.message.role !== "user") return;
    // Pi emits the event before appendMessage; run only after that event returns.
    setTimeout(() => { for (const id of pending.keys()) void confirm(id).catch(() => {}); }, 0);
  });
  pi.on("session_shutdown", () => {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    connection?.destroy();
    for (const state of pending.values()) state.ack?.destroy();
    pending.clear();
  });
}
