// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A representative subset of the per-agent launch options checks, so the suite catches a regression in
// the four paths that matter without paying for seventeen server and PTY host starts on every run:
// the per-launch field, the refusal class, the stored default, and the agent-requested session with
// its consent projection. The complete list stays one command away and is what a reviewer runs before
// merging (see the pull request and docs/operations.md):
//
//   for c in pi-extension token-bounds refused-forms pi-quoting refuse-yolo-write default-applies \
//            stale-revision write-authorization default-write-fails disabled-preset-entry \
//            agent-supplied-options consent-projection requested-model-wins resume-untouched \
//            approval-bound-to-options empty-token conversation-options-per-agent; do
//     node --experimental-strip-types tools/check-launch-options.ts "$c" || echo "RED: $c"
//   done
import {describe, test} from 'node:test';
import {CASES, runCase} from '../tools/check-launch-options.ts';

const IN_THE_SUITE = ['pi-extension', 'refused-forms', 'default-applies', 'consent-projection'] as const;

describe('per-agent launch options', () => {
  for (const name of IN_THE_SUITE) {
    test(name, {timeout: 120_000}, async () => {
      if (!CASES[name]) throw new Error(`missing check: ${name}`);
      await runCase(name);
    });
  }
});
