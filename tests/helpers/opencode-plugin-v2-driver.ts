// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Runs the real Mesh OpenCode 2 plugin the way OpenCode 2 does (one call to `setup` with a context whose
// `event.subscribe` yields the events) without OpenCode: argv[2] is a JSON array of events, the environment
// is the session's (MESH_PORT, MESH_SESSION_TOKEN). Used by the OpenCode 2 tests.
import plugin from '../../opencode-mesh-plugin-v2/index.ts';

const events = JSON.parse(process.argv[2] ?? '[]') as {type: string; data?: unknown}[];
async function* subscribe(): AsyncGenerator<{type: string; data?: unknown}> {
  for (const event of events) {
    yield event;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const dispose = await plugin.setup({event: {subscribe: () => subscribe()}});
// The requests are fire-and-forget inside the plugin; give them time to complete before exiting.
await new Promise(resolve => setTimeout(resolve, 800));
dispose();
