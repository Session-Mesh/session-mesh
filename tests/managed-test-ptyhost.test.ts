// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startTestPtyhost} from './helpers/managed-test-ptyhost.ts';

test('failed PTY host spawn rejects readiness and cleanup completes', async () => {
  const host = startTestPtyhost(['/nonexistent-mesh-test-host'], {stdio:'ignore'}, '/nonexistent-mesh-test-socket');
  await assert.rejects(host.ready, (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  await host.stop();
});
