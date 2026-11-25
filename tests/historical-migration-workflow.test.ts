// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('scheduled migration checks run isolated on main and do not skip historical scenarios', () => {
  const workflow = readFileSync('.github/workflows/historical-migrations.yml', 'utf8');
  assert.match(workflow, /^  schedule:$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.match(workflow, /^  pull_request:$/m);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /github\.token|secrets\.|workflow_run|pull_request_target/);
  assert.match(workflow, /MESH_HISTORICAL_DYNAMIC=1 MESH_REQUIRE_HISTORICAL_MIGRATION=1/);
  assert.match(workflow, /grep -qx '# skipped 0'/);
  assert.match(workflow, /grep -qx '# pass 4'/);
});
