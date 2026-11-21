// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>
// MESH_CHROMIUM: actual-page inventory tests, discovered by browser shards.

import assert from 'node:assert/strict';
import {test, harness} from '../checks/dictation-browser-fixture.ts';

declare const dictation: any;
declare function refresh(): Promise<unknown>;

test('inventory badge churn does not allocate dictation sessions or discard an existing draft', async () => {
  await harness(async (page, api) => {
    await page.evaluate(() => dictation.session('A', 1).edit('retained A draft'));
    const before = await page.evaluate(() => Reflect.get(dictation, 'sessions').size);
    for (let batch = 0; batch < 10; batch++) {
      api.inventory.mesh.splice(3);
      for (let index = 0; index < 50; index++) {
        const name = `observed-${batch}-${index}`;
        api.inventory.mesh.push({...api.inventory.mesh[0], id: name, name, created: 1000 + batch * 50 + index});
      }
      await page.evaluate(async () => {await refresh();});
      assert.equal(await page.evaluate(name => data.mesh.some((row: {id: string}) => row.id === name), `observed-${batch}-49`), true,
        'the populated inventory batch must actually reach the page');
      assert.equal(await page.evaluate(() => Reflect.get(dictation, 'sessions').size), before,
        'a populated inventory refresh must not allocate dictation sessions');
    }
    api.inventory.mesh.splice(3);
    await page.evaluate(async () => {await refresh();});
    assert.equal(await page.evaluate(() => Reflect.get(dictation, 'sessions').size), before,
      'passive sidebar and pane badges must not retain every observed incarnation');
    assert.equal(await page.evaluate(() => dictation.session('A', 1).text), 'retained A draft');
  });
});
