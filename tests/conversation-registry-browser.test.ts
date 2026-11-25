// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {chromium} from 'playwright-core';
import {chromiumLaunchOptions, READY_TIMEOUT_MS} from './helpers/browser-launch.ts';
import {SIDS, withHistoryLab} from './history-resume-name-lib.ts';

const chrome = process.env.MESH_CHROMIUM || '';
const skip = !chrome && !process.env.MESH_REQUIRE_BROWSER ? 'MESH_CHROMIUM is required' : false;

test('History finds a closed conversation by an earlier label after server restart', {skip}, () =>
  withHistoryLab(async lab => {
    await lab.closedRenamed('claude', 'First audit label', 'Final audit label');
    await lab.restartServer();
    const browser = await chromium.launch(chromiumLaunchOptions(chrome));
    try {
      const page = await browser.newPage();
      const base = 'http://127.0.0.1:' + lab.where.port;
      await page.goto(base + '/login');
      await page.locator('input[name="token"]').fill(fs.readFileSync(path.join(lab.where.confDir, 'token'), 'utf8').trim());
      await Promise.all([page.waitForURL(base + '/'), page.locator('form button').click()]);
      await page.locator('#tab-hist').click();
      await page.locator('#filter').fill('First audit label');
      const names = page.locator(`#hlist .hitem[data-id="h:claude:${SIDS.claude}"] .name`);
      // One entry in Recently closed and one in the transcript list.
      await names.nth(1).waitFor({timeout: READY_TIMEOUT_MS});
      assert.deepEqual(await names.allTextContents(), ['Final audit label', 'Final audit label']);
      await names.last().click();
      await page.getByRole('heading', {name: 'Final audit label', exact: true}).waitFor();
    } finally {
      await browser.close();
    }
  }));
