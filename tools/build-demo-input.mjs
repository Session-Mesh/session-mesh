// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {build} from "esbuild";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";

const check=process.argv.includes("--check");const output=check?mkdtempSync(join(tmpdir(),"mesh-input-")):"demo-runtime";
try{
  await build({entryPoints:{"input-codec-v1":"static/demo-input-contract.ts","worker-protocol-v2":"static/demo-worker-protocol-v2.ts"},bundle:true,platform:"browser",format:"esm",outExtension:{".js":".mjs"},outdir:output});
  if(check)for(const name of ["input-codec-v1.mjs","worker-protocol-v2.mjs"]){if(!readFileSync(join(output,name)).equals(readFileSync(join("demo-runtime",name))))throw Error(`${name} is stale`);}
}finally{if(check)rmSync(output,{recursive:true,force:true});}
