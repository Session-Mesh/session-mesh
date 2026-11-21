// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export function createRetainedLifetime(close: () => void) {
  let attached = true, disposed = false, refs = 0;
  const check = (): void => {if (!disposed && !attached && !refs) {disposed = true; close();}};
  return {
    retain(): (() => void) | null {
      if (disposed) return null;
      refs++; let held = true;
      return () => {if (!held) return; held = false; refs--; check();};
    },
    detach(): void {attached = false; check();},
    dispose(): void {if (disposed) return; disposed = true; close();},
  };
}
