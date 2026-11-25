// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Only remove the fixture after every applicable retirement has succeeded. */
export async function cleanupHistoricalFixture(scratch: string, steps: {
  stopServer(): Promise<void>;
  retireHost(): Promise<void>;
  stopHost(): Promise<void>;
  removeScratch(): void;
}): Promise<void> {
  const errors: unknown[] = [];
  try { await steps.stopServer(); } catch (error) { errors.push(error); }
  try { await steps.retireHost(); } catch (error) { errors.push(error); }
  try { await steps.stopHost(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, `fixture cleanup unconfirmed; retained ${scratch}`);
  steps.removeScratch();
}
