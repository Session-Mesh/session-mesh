// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/** Poll while the project is visible. A single read runs at a time. */
export function projectPoll(read: () => Promise<void>, interval = 15000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (!stopped) timer = setTimeout(() => void tick(), interval);
  };
  const tick = async (): Promise<void> => {
    try { if (document.visibilityState === 'visible') await read(); }
    finally { schedule(); }
  };
  schedule();
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
}
