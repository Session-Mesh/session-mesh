// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

test('the optional dictation bridge retains the documented Python 3.10 deadline primitives', () => {
  const source = readFileSync('server.py', 'utf8');
  const start = source.indexOf('async def start_dictation(');
  const end = source.indexOf('# ---------------------------------------------------------------- ptyhost', start);
  assert.ok(start >= 0 && end > start);
  const bridge = source.slice(start, end);
  assert.doesNotMatch(bridge, /asyncio\.timeout\s*\(/, 'the context manager requires Python 3.11');
  assert.match(bridge, /asyncio\.wait_for\(worker\.stdout\.readline\(\), 5\)/);
  assert.match(bridge, /asyncio\.wait_for\(worker\.wait\(\), 3\)/);
  assert.match(bridge, /asyncio\.wait_for\(request\.app\["dictation_capacity"\]\.acquire\(\), 0\.05\)/);
  assert.match(bridge, /except asyncio\.TimeoutError:/);
});

test('the dictation client uses the bounded aiohttp parser default without a newer ClientSession keyword', () => {
  const source = readFileSync('server.py', 'utf8');
  const client = source.slice(source.indexOf('app["dictation_client"] = aiohttp.ClientSession('), source.indexOf('app["dictation_capacity"] ='));
  assert.match(client, /ClientSession\(/);
  assert.doesNotMatch(client, /max_field_size\s*=/, 'aiohttp 3.8 uses its 8190-byte parser default, not this ClientSession option');
});
