// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// MESH_CHROMIUM: the browser shard selector scans root test files, not nested imports.
// Keep all legacy journeys and seven consumer ratchets reachable without changing CI.
import './browser/dictation.test.ts';
import './browser/dictation-lifecycle.test.ts';
import './browser/dictation-fixture.test.ts';
import './browser/dictation-ratchets.test.ts';
