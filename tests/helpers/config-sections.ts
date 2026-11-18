// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Browser-test helpers for the sections of the Configuration dialog: open one section whatever the
// width (a sidebar entry on a wide window, a list entry then a back button on a phone).
import type {Page} from 'playwright-core';

export const SECTIONS = ['appearance', 'terminal', 'notifications', 'updates', 'agents', 'system'] as const;
export type SectionId = typeof SECTIONS[number];

export async function showSection(page: Page, id: SectionId): Promise<void> {
  const back = page.locator('#dlg-config .config-back');
  if (await back.isVisible()) await back.click();
  await page.locator(`#dlg-config .config-nav-button[data-section-id="${id}"]`).click();
  await page.locator('#dlg-config .config-cards').waitFor();
}

// Visit every section in turn and run `visit` on each: the dialog shows one section at a time.
export async function eachSection(page: Page, visit: (id: SectionId) => Promise<void>): Promise<void> {
  for (const id of SECTIONS) { await showSection(page, id); await visit(id); }
}

// The text of every section, concatenated.
export async function allSectionsText(page: Page): Promise<string> {
  const parts: string[] = [];
  await eachSection(page, async () => { parts.push(await page.locator('#dlg-config .config-cards').innerText()); });
  return parts.join('\n');
}
