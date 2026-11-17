// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Excalidraw 0.17.6 draws text in the font families "Virgil" (hand-drawn) and
// "Cascadia" (code), and existing scenes ask for them by number. Their files are
// not shipped: Virgil is freeware for personal use and Cascadia's embedded license
// opens with a Microsoft-only clause (static/vendor/THIRD_PARTY.md). This module
// gives both family names to free fonts kept in static/vendor/fonts/, without
// touching the Excalidraw package.
//
// Excalidraw injects its own @font-face rules for these families, pointing at the
// absent files, when its module is evaluated (before this module's caller runs).
// Those rules are removed from the page's style sheets, else a FontFaceSet.load()
// of the family (which Excalidraw runs for the fonts of a scene) would also try
// the absent files and reject; the free fonts are then declared under the names.
export const FREE_FONTS = Object.freeze([
  { family: "Virgil", url: "/static/vendor/fonts/Excalifont-Regular.woff2", format: "woff2" },
  { family: "Cascadia", url: "/static/vendor/fonts/ComicShanns2-Regular.ttf", format: "truetype" },
]);

const FONT_FACE_RULE = 5;   // CSSRule.FONT_FACE_RULE

export function fontFaceRules(fonts = FREE_FONTS) {
  return fonts
    .map(({ family, url, format }) => `@font-face{font-family:"${family}";src:url("${url}") format("${format}");font-display:swap}`)
    .join("\n");
}

function familyOf(rule) {
  return rule.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "");
}

// Removes the @font-face rules of the mapped families; returns how many it removed.
export function removeMappedFaces(doc, fonts = FREE_FONTS) {
  const families = new Set(fonts.map((font) => font.family));
  let removed = 0;
  for (const sheet of doc.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }   // a cross-origin sheet cannot be read
    for (let index = rules.length - 1; index >= 0; index -= 1) {
      if (rules[index].type === FONT_FACE_RULE && families.has(familyOf(rules[index]))) {
        sheet.deleteRule(index);
        removed += 1;
      }
    }
  }
  return removed;
}

export function installFreeFonts(doc = document) {
  removeMappedFaces(doc);
  const style = doc.createElement("style");
  style.setAttribute("data-mesh-free-fonts", "");
  style.textContent = fontFaceRules();
  doc.head.append(style);
  return style;
}
