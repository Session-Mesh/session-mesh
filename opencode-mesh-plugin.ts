// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// OpenCode plugin loaded by Session Mesh (config key "plugin", injected per session through
// OPENCODE_CONFIG_CONTENT, see agentmcp.opencode_config). It reports working / waiting /
// done to this mesh so a mailbox wake notice is typed only while OpenCode is idle at its
// prompt, exactly as Claude's hooks do. It never writes to the terminal and never fails
// OpenCode: every error is swallowed.
//
// The request carries the session token, so it uses node:http, which ignores proxy
// environment variables (the global fetch of some runtimes does not), and refuses redirects.
import http from 'node:http';
import {EventTranslator, type MeshEvent, type OpenCodeEvent} from './opencode-mesh-events.ts';

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

export const SessionMeshPlugin = async () => {
  const translator = new EventTranslator();
  return {
    event: async ({event}: {event: OpenCodeEvent}) => {
      try {
        const translated = translator.translate(event);
        if (translated !== null) post(translated, process.env);
      } catch {
        // Observability must never become a dependency of the agent it observes.
      }
    },
  };
};
