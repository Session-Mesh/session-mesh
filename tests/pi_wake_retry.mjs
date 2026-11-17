// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Exercise Pi's void-returning extension API with a failed first send.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, appendFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "mesh-pi-wake-"));
const transcript = join(dir, "session.jsonl");
const newTranscript = join(dir, "new-session.jsonl");
await writeFile(transcript, JSON.stringify({ padding: "x".repeat(70000) }) + "\n");
let sessionFile = transcript;
const id = "a".repeat(32);
let stream, attempts = 0, acknowledgements = 0, idle = true, clock = 1000;
const originalNow = Date.now;
Date.now = () => clock;
let resolveAck;
const acked = new Promise(resolve => { resolveAck = resolve; });
let resolveFirstAck;
const firstAck = new Promise(resolve => { resolveFirstAck = resolve; });
const server = http.createServer((request, response) => {
  if (request.method === "GET") {
    assert.equal(request.headers.authorization, "MeshSession test-only");
    stream = response;
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.write('{"ready":true}\n');
  } else {
    assert.equal(request.headers.authorization, "MeshSession test-only");
    acknowledgements++;
    if (acknowledgements === 1) { resolveFirstAck(); return; } // stalled Web
    response.writeHead(200);
    response.end();
    resolveAck();
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.env.MESH_SESSION_TOKEN = "test-only";
process.env.MESH_PORT = String(server.address().port);
const { default: extension } = await import("../pi_mesh_wake.mjs");
const handlers = {};
const branch = [];
const ctx = { sessionManager: { getSessionFile: () => sessionFile, getBranch: () => branch },
  isIdle: () => idle, hasPendingMessages: () => false };
extension({
  on: (name, callback) => { handlers[name] = callback; },
  sendUserMessage: (text, options) => {
    assert.equal(options.deliverAs, "steer");
    attempts++;
    if (attempts === 2) {
      const entry = { type: "message", id: "second", message: { role: "user", content: text } };
      sessionFile = newTranscript; // Pi /new or /resume changed the transcript
      branch.push(entry);
      void appendFile(sessionFile, `${JSON.stringify(entry)}\n`).then(() => {
        handlers.message_end({ message: entry.message });
      });
    }
  },
});
handlers.session_start({}, ctx);
while (!stream) await new Promise(resolve => setTimeout(resolve, 5));
const notice = JSON.stringify({ notification_id: id, count: 1 }) + "\n";
stream.write(notice);
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(attempts, 1);
clock += 11000;
idle = false;
stream.write(notice);
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(attempts, 1, "never retry while Pi is busy");
idle = true;
stream.write(notice);
await Promise.race([firstAck, new Promise((_, reject) => setTimeout(() => reject(new Error("no first ACK")), 3000))]);
stream.write(notice);
await new Promise(resolve => setTimeout(resolve, 50));
assert.equal(acknowledgements, 1, "only one ACK request may be in flight");
await new Promise(resolve => setTimeout(resolve, 5100));
stream.write(notice);
await Promise.race([acked, new Promise((_, reject) => setTimeout(() => reject(new Error("no retry ACK")), 3000))]);
assert.equal(attempts, 2);
assert.equal(acknowledgements, 2);
handlers.session_shutdown();
stream.destroy();
await new Promise(resolve => server.close(resolve));
Date.now = originalNow;
await rm(dir, { recursive: true });
