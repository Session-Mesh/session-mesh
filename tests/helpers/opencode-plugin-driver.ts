// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Runs the real Mesh OpenCode plugin the way OpenCode does (one call to the exported plugin, then its
// `event` hook for each event) without OpenCode: argv[2] is a JSON array of events, the environment is
// the session's (MESH_PORT, MESH_SESSION_TOKEN). Used by the OpenCode tests.
import {SessionMeshPlugin} from '../../opencode-mesh-plugin.ts';

const events = JSON.parse(process.argv[2] ?? '[]') as {type: string; properties?: unknown}[];
const plugin = await SessionMeshPlugin();
for (const event of events) await plugin.event({event});
// The requests are fire-and-forget inside the plugin; give them time to complete before exiting.
await new Promise(resolve => setTimeout(resolve, 600));
