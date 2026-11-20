// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The restore routes (POST /api/restore, /api/restore/discard) take at most RESTORE_MAX names per
// request (server.py) and answer 400 above. An offer can hold more (a host restart that lost 53
// sessions), so the page sends the names in batches of at most that many, one after the other.

// Mirrors server.py RESTORE_MAX.
export const RESTORE_BATCH_MAX = 50;

// The names, in their order, cut into consecutive batches of at most `max`.
export function restoreBatches(names: readonly string[], max: number = RESTORE_BATCH_MAX): string[][] {
  if (!Number.isInteger(max) || max < 1) throw new RangeError("max");   // not a positive integer
  const batches: string[][] = [];
  for (let start = 0; start < names.length; start += max) batches.push(names.slice(start, start + max));
  return batches;
}

// What one request answered: its results by session name, or the error that stopped it (an HTTP
// refusal or a transport failure).
export type BatchOutcome<R> = { readonly ok: true; readonly results: Readonly<Record<string, R>> }
  | { readonly ok: false; readonly error: string };

export interface BatchedRestore<R> {
  readonly results: Record<string, R>;   // every answered batch, merged by session name
  readonly sent: string[];               // the names of the batches that were answered
  readonly unsent: string[];             // the names of the failed batch and of those after it
  readonly error: string | null;         // why the sequence stopped, or null when every batch was answered
}

// Sends the batches one after the other and stops at the first one that fails: the names not
// sent stay offered by the server, and the results of the batches already answered are kept.
export async function postInBatches<R>(names: readonly string[],
                                       post: (batch: string[]) => Promise<BatchOutcome<R>>,
                                       max: number = RESTORE_BATCH_MAX): Promise<BatchedRestore<R>> {
  const results: Record<string, R> = {};
  const sent: string[] = [];
  const batches = restoreBatches(names, max);
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index] ?? [];
    const outcome = await post(batch);
    if (!outcome.ok) return { results, sent, unsent: batches.slice(index).flat(), error: outcome.error };
    mergeResults(results, outcome.results);
    sent.push(...batch);
  }
  return { results, sent, unsent: [], error: null };
}

// Adds one batch's results to the merged ones, by session name. Only own string keys are copied,
// so a name such as "__proto__" stays an ordinary entry.
export function mergeResults<R>(into: Record<string, R>, batch: Readonly<Record<string, R>> | null | undefined): Record<string, R> {
  if (!batch || typeof batch !== "object") return into;
  for (const name of Object.keys(batch)) {
    Object.defineProperty(into, name, { value: batch[name] as R, enumerable: true, writable: true, configurable: true });
  }
  return into;
}
