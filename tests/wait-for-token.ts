// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The server writes its token file at import and binds its port only later, so the file appearing means
// our server has started. The port, by contrast, can answer before that: another process of a parallel
// test run can hold the same number between freePort() closing its probe and the server's bind. A test
// that reads the token as soon as the port answers can therefore hit ENOENT. This waits for the file,
// then for the server to accept that token, and fails with a message naming what was missing.
import fs from 'node:fs';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The token in `file`, once it exists and is not empty; bounded, with a clear error on timeout. */
export async function waitForToken(file: string, timeoutMs = 20_000, stepMs = 50): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`the server wrote no token file ${file} within ${timeoutMs} ms`);
    await sleep(stepMs);
  }
}

/** Wait for the token file, then until `url` answers 200 to that token; returns the token. */
export async function waitForServer(file: string, url: string, origin: string, timeoutMs = 20_000, stepMs = 50): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const token = await waitForToken(file, timeoutMs, stepMs);
  let last = 'no answer';
  let sawStatus = false;
  for (;;) {
    try {
      const response = await fetch(url, {headers: {Authorization: `Bearer ${token}`, Origin: origin},
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))});
      await response.arrayBuffer();
      if (response.status === 200) return token;
      last = `status ${response.status}`;
      sawStatus = true;
    } catch (error) {
      if (!sawStatus) last = (error as Error).message;   // the final aborted request must not hide a status
    }
    if (Date.now() >= deadline) throw new Error(`the server did not answer ${url} with its token within ${timeoutMs} ms (${last})`);
    await sleep(stepMs);
  }
}
