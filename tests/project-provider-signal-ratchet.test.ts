// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Direct ratchet: 0 pass, 1 assertion fired, >=2 setup/runtime failure. */
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function check(): Promise<void> {
  const { runProvider } = await import("../tools/project-snapshot.ts");
  const root = await mkdtemp(join(tmpdir(), "mi1-signal-"));
  const leader = join(root, "leader.mjs"), ready = join(root, "pipe-owner");
  const holder = `require("node:fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>process.exit(0),1100);`;
  await writeFile(leader, `#!/usr/bin/env node\nimport{spawn}from"node:child_process";const c=spawn(process.execPath,["-e",${JSON.stringify(holder)}],{detached:true,stdio:["ignore",1,2]});c.unref();console.log("{}");`, {mode:0o700});
  const originalSpawn = childProcess.spawn, originalKill = process.kill;
  const signals: { pid: number; signal: unknown; exitObserved: boolean }[] = [];
  let exitObserved = false, directPid = 0, markExit: () => void;
  const exited = new Promise<void>(resolve => { markExit = resolve; });
  let settled = false, failure: unknown;
  try {
    childProcess.spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
      const child = originalSpawn(...args);
      if (args[0] === leader) {
        directPid = child.pid!;
        child.once("exit", () => { exitObserved = true; markExit(); });
      }
      return child;
    }) as typeof childProcess.spawn;
    // All termination attempts are intercepted, never delivered to numeric PIDs/groups.
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGTERM") { signals.push({pid,signal,exitObserved}); return true; }
      if (signal !== 0 || !directPid) throw Error("unsafe probe signal");
      return originalKill(pid,signal);
    }) as typeof process.kill;
    syncBuiltinESMExports();
    const started = performance.now();
    const pending = runProvider(leader, [], {}, { timeoutMs: 500 }).then(
      () => { settled = true; }, error => { settled = true; failure = error; });
    await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(Error("leader exit setup timeout")), 2000))]);
    if (performance.now() - started >= 450) throw Error("leader did not exit before deadline: setup too slow");
    for (let i = 0; i < 100; i++) { try { await readFile(ready); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
    const holderPid = Number(await readFile(ready, "utf8"));
    if (!Number.isSafeInteger(holderPid) || holderPid <= 0) throw Error("missing known pipe holder");
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 650 - (performance.now() - started))));
    assert.equal(exitObserved, true, "actual owned ChildProcess exit must be observed");
    assert.equal(settled, false, "direct exit/deadline must not settle inherited pipes");
    assert.throws(() => originalKill(directPid, 0), {code:"ESRCH"}, "direct child was reaped");
    originalKill(holderPid, 0); // Only the PID written by this actual fixture is inspected.
    await pending;
    assert.equal((failure as {code?:string})?.code, "timeout");
    assert.deepEqual(signals, [], "reaped leader must revoke numeric process-group signal authority");
    console.log(JSON.stringify({case:"provider-post-exit-signal-authority",directPid,holderPid,exitObserved,settledAfterPipeClose:settled,terminationAttempts:signals,code:"timeout"}));
  } finally {
    childProcess.spawn = originalSpawn; process.kill = originalKill; syncBuiltinESMExports();
    await rm(root, {recursive:true,force:true});
  }
}
try { await check(); }
catch (error) {
  console.error(error);
  process.exitCode = error instanceof assert.AssertionError ? 1 : 2;
}
