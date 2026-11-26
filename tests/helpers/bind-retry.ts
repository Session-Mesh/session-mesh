// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Python's Linux and macOS errors for a failed TCP bind. */
export const isBindCollision = (output: string): boolean =>
  /OSError: \[Errno (?:98|48)\] error while attempting to bind[^\n]*address already in use/i.test(output);

/** Retry a fresh, self-cleaning fixture only for a confirmed server bind collision. */
export async function retryBindCollision<T>(start: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await start(); }
    catch (error) {
      if (attempt === 4 || !(error instanceof Error)
          || !error.message.startsWith('server.py did not listen:\n') || !isBindCollision(error.message)) throw error;
    }
  }
}
