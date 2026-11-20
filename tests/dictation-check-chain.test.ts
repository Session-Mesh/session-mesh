// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('the CI check chain includes dictation typing, generated freshness and regressions',()=>{
  const {scripts}=JSON.parse(fs.readFileSync('package.json','utf8'));
  assert.ok(scripts.check.split(' && ').includes('npm run check:dictation'));
  assert.match(scripts['check:dictation'],/^tsc --project tsconfig\.dictation\.json && node tools\/build-dictation\.mjs --check && /);
  for(const file of ['tests/dictation.test.ts','tests/dictation-auth.test.ts','tests/dictation-startup.test.ts','tests/dictation-check-chain.test.ts','tests/dictation-review-server.test.ts']){
    assert.ok(scripts['check:dictation'].includes(file),`missing ${file}`);
  }
});

test('worker freshness rejects changed source with a stale generated bundle',()=>{
  const root=process.cwd(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'mesh-freshness-'));
  try{
    for(const name of ['backend','shared','tools'])fs.mkdirSync(path.join(directory,name));
    for(const file of ['backend/dictation-main.ts','backend/dictation.ts','backend/dictation-service.ts','backend/dictation-service.cjs','tools/build-dictation.mjs']){
      fs.copyFileSync(file,path.join(directory,file));
    }
    if(fs.existsSync('shared/dictation-text.ts'))fs.copyFileSync('shared/dictation-text.ts',path.join(directory,'shared/dictation-text.ts'));
    fs.symlinkSync(path.join(root,'node_modules'),path.join(directory,'node_modules'),'dir');
    const check=()=>spawnSync(process.execPath,['tools/build-dictation.mjs','--check'],{cwd:directory,encoding:'utf8',timeout:10000});
    assert.equal(check().status,0,'unchanged bundle is fresh');
    const source=path.join(directory,'backend/dictation.ts');
    const original=fs.readFileSync(source,'utf8');
    const changed=original.replace('Invalid dictation request.','Changed fixture request.');
    assert.notEqual(changed,original,'mutation must affect emitted code');
    fs.writeFileSync(source,changed);
    const stale=check();assert.equal(stale.status,1);assert.match(stale.stderr,/is stale; run npm run build:dictation/);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
