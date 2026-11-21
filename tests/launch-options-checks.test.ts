// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The runnable checks of the per-agent launch options, one test per named case, so CI runs them:
// the program in tools/check-launch-options.ts is the same code, with the 0/1/2 exit convention for
// a manual run. Each case starts its own server and PTY host with a fake `pi` on PATH.
import {describe, test} from 'node:test';
import {CASES, runCase} from '../tools/check-launch-options.ts';

describe('per-agent launch options', () => {
  for (const name of Object.keys(CASES)) {
    test(name, async () => { await runCase(name); });
  }
});
