// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// When a window resize closes the narrow layout's sidebar (the drawer). A phone's soft keyboard
// (the page asks for `interactive-widget=resizes-content`) and its browser toolbar showing or
// hiding change only the viewport's height: the drawer stays open, so a field in it (the sessions
// filter) stays in sight while the user types. A change of width (a rotation, a window resized,
// leaving the narrow layout) closes it, as before.
export function drawerClosesOnResize(previousWidth: number, width: number): boolean {
  return width !== previousWidth;
}
