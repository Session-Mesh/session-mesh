// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// A server accepts connections before it has written its token file, so a test that reads the file
// as soon as the port answers can race it. This waits for the file, then for the server to accept
// that token, and fails with a message naming what was missing instead of a raw ENOENT.
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
  for (;;) {
    try {
      const response = await fetch(url, {headers: {Authorization: `Bearer ${token}`, Origin: origin},
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now()))});
      await response.arrayBuffer();
      if (response.status === 200) return token;
      last = `status ${response.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
    if (Date.now() >= deadline) throw new Error(`the server did not answer ${url} with its token within ${timeoutMs} ms (${last})`);
    await sleep(stepMs);
  }
}
