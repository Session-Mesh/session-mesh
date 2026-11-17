// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// OpenCode 2 plugin loaded by Session Mesh (config key "plugins": [{"package": <this folder>}], injected per
// session through OPENCODE_CONFIG_CONTENT, see agentmcp.opencode_config_v2). It reports working / waiting /
// done to this mesh so a mailbox wake notice is typed only while OpenCode is idle at its prompt, exactly as
// Claude's hooks do. It never writes to the terminal and never fails OpenCode: every error is swallowed.
//
// OpenCode 2 is launched with --standalone, so this plugin runs in the server process of that terminal only:
// MESH_SESSION_TOKEN is the one of that terminal's environment. The request carries it, so it uses
// node:http, which ignores proxy environment variables, and refuses redirects.
import http from 'node:http';
import {EventTranslatorV2, type MeshEvent, type OpenCodeV2Event} from './events.ts';

const TIMEOUT_MS = 1500;

function port(environment: NodeJS.ProcessEnv): number | null {
  const value = environment.MESH_PORT ?? '7690';
  return /^[0-9]{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : null;
}

function post(event: MeshEvent, environment: NodeJS.ProcessEnv): void {
  const token = (environment.MESH_SESSION_TOKEN ?? '').trim();
  const target = port(environment);
  if (token === '' || target === null) return;
  const body = JSON.stringify(event);
  const request = http.request({
    host: '127.0.0.1', port: target, path: '/api/event', method: 'POST', timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      Authorization: `MeshSession ${token}`,
    },
  }, response => { response.resume(); });
  request.on('error', () => {});
  request.on('timeout', () => request.destroy());
  request.end(body);
}

interface PluginContext {
  event: {subscribe(options: {signal: AbortSignal}): AsyncIterable<OpenCodeV2Event>};
}

export default {
  id: 'session-mesh-state',
  async setup(context: PluginContext) {
    const translator = new EventTranslatorV2();
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of context.event.subscribe({signal: controller.signal})) {
          try {
            const translated = translator.translate(event);
            if (translated !== null) post(translated, process.env);
          } catch {
            // Observability must never become a dependency of the agent it observes.
          }
        }
      } catch {
        // The subscription ended (shutdown) or failed: nothing to report.
      }
    })();
    return () => controller.abort();
  },
};
