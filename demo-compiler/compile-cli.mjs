// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {compileDemoSource, MAX_SOURCE_BYTES} from "./compile.mjs";

async function main() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.byteLength;
    if (length > MAX_SOURCE_BYTES) throw Error("oversized input");
    chunks.push(chunk);
  }
  const source = new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, length));
  const bundle = await compileDemoSource(source);
  if (!process.stdout.write(bundle)) await new Promise(resolve => process.stdout.once("drain", resolve));
}

try {
  await main();
} catch {
  // Compiler errors can contain supplied source. Never echo them to a log.
  process.stderr.write("demo compiler refused input\n");
  process.exitCode = 78;
}
