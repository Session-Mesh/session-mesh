// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// What every browser test shares: the Chromium launch options and the readiness budget.
//
// The interface language is chosen from navigator.languages (static/i18n.js), which Chromium takes
// from the environment of the machine (LANGUAGE, LC_ALL, LANG) when a context sets no locale of its
// own. A developer under a French locale therefore got the French interface in every test that
// asserts English labels. Browsers started through chromiumLaunchOptions run in English whatever the
// caller's locale; a test that covers another language passes `locale` to its own context, which
// takes precedence. On Linux it is the fixed environment (browserEnv) that sets the language: the
// --lang switch alone does not change navigator.languages in a headless Chromium there (measured
// under LANG=fr_FR); the switch is kept for the platforms where Chromium honours it.
import type {LaunchOptions} from 'playwright-core';

/** The one budget for "the page is loaded and its first state arrived", shared by the browser tests. */
export const READY_TIMEOUT_MS = 30_000;

/** The locale of the browsers the tests start, unless a test asks for another one. */
export const BROWSER_LOCALE = 'en-US';

/** The environment of a browser process: the caller's own, with a fixed locale. */
export function browserEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  return {...env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', LANGUAGE: 'en_US:en'};
}

/** Launch options of a Chromium that shows the English interface. */
export function chromiumLaunchOptions(executablePath: string, args: string[] = []): LaunchOptions {
  return {executablePath, args: [...args, `--lang=${BROWSER_LOCALE}`], env: browserEnv()};
}
