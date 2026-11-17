// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';

for(const file of ['project-cockpit-view.ts','project-artifact-view.ts']){
  test(`reader module ${file} imports with native Node type stripping`,()=>{
    const url=new URL('../static/'+file,import.meta.url).href;
    const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`await import(${JSON.stringify(url)})`],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  });
}
