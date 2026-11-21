// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

export function hasDictationControls(text: string): boolean {
  return /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text);
}
