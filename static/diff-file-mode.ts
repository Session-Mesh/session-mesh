// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The file modes of a Git diff (static/diff-view.ts): the extended header lines `old mode`,
// `new mode`, `new file mode` and `deleted file mode` say when a file became executable (or a
// symbolic link, or no longer so). They are kept, so that a change of mode is shown even when the
// content did not change (a chmod).

export interface FileModes {
  // the mode before (absent for a created file) and after (absent for a deleted one)
  oldMode: string | null;
  newMode: string | null;
}

const MODE_LINES: [string, keyof FileModes][] = [
  ['old mode ', 'oldMode'], ['new mode ', 'newMode'],
  ['new file mode ', 'newMode'], ['deleted file mode ', 'oldMode'],
];

// Git writes a mode as six octal digits (100644, 100755, 120000, 160000, ...).
const MODE = /^[0-7]{6}$/;

// Records the mode an extended header line gives, if it gives one: any other text after the
// prefix (a commit message line of the next patch in a series, say) is not a mode.
export function readModeLine(line: string, file: FileModes): void {
  for (const [prefix, key] of MODE_LINES) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length).trim();
    if (MODE.test(value)) file[key] = value;
  }
}

// The mode to show beside the name: `100644 → 100755` for a change, the mode of a created or
// deleted file, or null when the diff gives none (or the same one twice).
export function modeLabel(file: FileModes): string | null {
  const {oldMode, newMode} = file;
  if (oldMode && newMode) return oldMode === newMode ? null : `${oldMode} → ${newMode}`;
  return oldMode ?? newMode;
}
