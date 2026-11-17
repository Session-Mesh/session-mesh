# Vendored libraries

Session Mesh itself is AGPL-3.0-or-later (`LICENSE` at the repository root). The
files below are third-party and keep their own licenses. Full license texts are
in `LICENSES/` at the repository root (and `monaco/LICENSE` here).

Rule (owner decision, 2026-11-13): a third-party file whose license is not
compatible with the AGPL-3.0 and GPL-3.0, or whose license cannot be
established, is not shipped: the build stops copying it (the library itself is
never forked or patched). A file under a compatible license is shipped
unchanged, its license named here and its text in `LICENSES/`.

Each section carries machine-read lines, checked by `tools/check-third-party.mjs`
(run `node tools/check-third-party.mjs`):

- `Files:` comma-separated glob patterns, relative to `static/vendor/`; every
  file under `static/vendor/` must match a section.
- `License:` the SPDX license expression of the section (`AND`, `OR`,
  parentheses). Every identifier must be in the allowed list of
  `tools/third-party/licenses.mjs`, which gives the reason for each; for `OR`,
  one allowed alternative is enough.
- `License-File:` repository-relative path, inside the repository, of a license
  text that must exist (one line per text).
- `Inventory:` and `Package:` (whiteboard bundle only): `Package:` gives
  `name version SPDX` of each npm package that esbuild puts into `board-*.js`;
  the file named by `Inventory:` (`board-packages.json`, written by
  `npm run build:board` from the esbuild metafile, with the license each
  package declares in its `package.json`) must list exactly these, and each
  declared license must be allowed. `tests/third-party-licenses.test.ts`
  rebuilds the bundle in memory and compares it with that file. Libraries a
  package embeds in its own prebuilt file are not seen this way and are listed
  in prose, found by reading the files.
- `License-Status: unresolved` when no license allowing redistribution could be
  established from a primary source. The checker fails on such a section, as on
  a section without `License:` (`--strict`, formerly needed for this, is now the
  default and still accepted).

## Excalidraw 0.17.6 — MIT

Files: board-*.js, board-*.js.LEGAL.txt, board-*.css, board-assets.json, board-packages.json, excalidraw-assets/locales/*
License: MIT AND Apache-2.0 AND Zlib AND 0BSD
Inventory: board-packages.json
License-File: LICENSES/MIT-excalidraw.txt
License-File: LICENSES/MIT-react.txt
License-File: LICENSES/Apache-2.0.txt
License-File: LICENSES/MIT-pako.txt
License-File: LICENSES/Zlib-pako.txt
License-File: LICENSES/MIT-roughjs.txt
License-File: LICENSES/MIT-perfect-freehand.txt
License-File: LICENSES/MIT-jotai.txt
License-File: LICENSES/MIT-radix-ui.txt
License-File: LICENSES/MIT-excalidraw-bundled.txt
License-File: LICENSES/0BSD-tslib.txt
Package: @excalidraw/excalidraw 0.17.6 MIT
Package: react 18.3.1 MIT
Package: react-dom 18.3.1 MIT
Package: scheduler 0.23.2 MIT

`board-*.js`, `board-*.css` and the locally copied `excalidraw-assets/` tree are a
content-addressed production bundle of `@excalidraw/excalidraw@0.17.6`, React
18.3.1 and ReactDOM 18.3.1. They are built from the committed `package-lock.json`
with `npm run build:board`; `board-assets.json` records each artifact SHA-256 and
`board-packages.json` the npm packages esbuild bundled (the `Package:` lines
above). No CDN, telemetry endpoint or remote font is used. The bundle's notices
are in the matching `board-*.js.LEGAL.txt` file.

Only part of the package's `dist/excalidraw-assets/` is copied: the Assistant
fonts and `locales/`. Not shipped, under the rule above:

- `vendor-*.js`, the chunk Excalidraw loads on demand for the "Mermaid to
  Excalidraw" dialog, image resizing (pica) and its file dialogs: it embeds
  elkjs 0.8.2 (EPL-2.0, with EMF classes under the EPL-1.0), neither compatible
  with the GPL. The whiteboard hides that dialog's menu entry and the image tool,
  and has no file dialogs (`static/board-src.mjs`).
- `Virgil.woff2`, a freeware font for personal use only (its name table: "Freeware
  for personal use! [...]", Copyright (c) 2011 by Your Own Font Foundry); the
  copy in https://github.com/excalidraw/virgil carries the same name table,
  whatever the `LICENSE.md` of that repository says.
- `Cascadia.woff2`, Cascadia Code 1911.210, whose name table opens with a
  Microsoft clause ("Microsoft supplied font. [...] Any other use is
  prohibited.") before a license "based on the SIL Open Font license"; the
  current release (2407.24) embeds the same text, so its license is not one of
  the allowed ones.

The whiteboard asks for the families `Virgil` and `Cascadia` (as do existing
scenes, `fontFamily` 1 and 3); `static/board-fonts.mjs` maps them to the fonts of
the next two sections.

Excalidraw is Copyright (c) 2020 Excalidraw, under the MIT license (full text in
`LICENSES/MIT-excalidraw.txt`, taken from the `v0.17.6` tag of
https://github.com/excalidraw/excalidraw; the npm package ships no license file).
React, ReactDOM and scheduler are Copyright (c) Facebook, Inc. and its
affiliates, MIT (`LICENSES/MIT-react.txt`).

The Excalidraw notice inside `board-*.js.LEGAL.txt` says "For license information
please see excalidraw.production.min.js.LICENSE.txt". That file is not shipped
here; in the `@excalidraw/excalidraw@0.17.6` npm tarball (`dist/`) it lists four
notices, all MIT: regenerator-runtime (Copyright (c) 2014-present, Facebook,
Inc.), and the React builds `react-jsx-runtime.production.min.js`,
`use-sync-external-store-shim.production.min.js` and
`use-sync-external-store-shim/with-selector.production.min.js` (Copyright (c)
Facebook, Inc. and its affiliates; `LICENSES/MIT-react.txt`).

Known naming mismatch, not fixed here: `board-*.js` itself ends with "For license
information please see board-<esbuild hash>.js.LEGAL.txt", the name esbuild gave
the file before `tools/build-board.mjs` renamed it to the content-addressed
`board-<hash>.js.LEGAL.txt` that is shipped.

The Excalidraw bundle inside `board-*.js` also embeds libraries that no notice
names. Each was found in the file itself; the version is the exact one pinned in
the root `package.json` of the excalidraw repository at tag `v0.17.6` (the npm
package declares no dependencies), and the license text is the one in that
version's npm tarball unless stated otherwise:

- pako 1.0.11 (the strings "pako deflate (from Nodeca project)" and "pako
  inflate (from Nodeca project)"), MIT AND Zlib: MIT, Copyright (C) 2014-2017 by
  Vitaly Puzrin and Andrei Tuputcyn (`LICENSES/MIT-pako.txt`), and for the zlib
  port, (C) 1995-2013 Jean-loup Gailly and Mark Adler, (C) 2014-2017 Vitaly
  Puzrin and Andrey Tupitsin, under the zlib license (`LICENSES/Zlib-pako.txt`,
  the notice at the top of `lib/zlib/crc32.js` in the tarball, comment markers
  removed). The CRC-32 routine built on the `3988292384` (0xEDB88320) constant
  is pako's own `lib/zlib/crc32.js`.
- SheetJS crc-32 0.3.0 (a module setting `version="0.3.0"` and building its
  table with the signed constant `-306674912`), pulled in by png-chunks-encode
  1.0.0 (`crc-32 ^0.3.0`): Copyright (C) 2014 SheetJS, Apache-2.0
  (`LICENSES/Apache-2.0.txt`; the tarball's `LICENSE` is the short Apache
  notice carrying that copyright line).
- roughjs 4.6.4 (the hachure fillers, `hachureAngle`, `fillPolygons`): MIT,
  Copyright (c) 2019 Preet Shihn (`LICENSES/MIT-roughjs.txt`).
- perfect-freehand 1.2.0 (the stroke function with the `size`, `smoothing`,
  `thinning`, `simulatePressure` and `easing` options): MIT, Copyright (c) 2021
  Stephen Ruiz Ltd (`LICENSES/MIT-perfect-freehand.txt`).
- jotai 1.13.1 (its store, with the error "no atom init", and Excalidraw's
  `jotaiScope`): MIT, Copyright (c) 2020-2023 Poimandres
  (`LICENSES/MIT-jotai.txt`).
- @radix-ui/react-popover 1.0.3 and @radix-ui/react-tabs 1.0.2 with their
  @radix-ui dependencies (the `data-radix-focus-guard` and
  `data-radix-popper-content-wrapper` attributes): MIT, Copyright (c) 2022
  WorkOS. The tarballs ship no license file; `LICENSES/MIT-radix-ui.txt` is the
  `LICENSE` of https://github.com/radix-ui/primitives at commit `ee4e3197bf`
  (2022-06-01, the last change to that file before and after these releases).
- browser-fs-access 0.29.1 (the support test returning `"showOpenFilePicker"`
  when not framed): Apache-2.0 (`LICENSES/Apache-2.0.txt`, identical to the
  tarball's `LICENSE` apart from a leading blank line); the package carries no
  copyright line, its author is Thomas Steiner, repository
  https://github.com/GoogleChromeLabs/browser-fs-access.

The same bundle embeds further MIT packages, pulled in by Excalidraw itself or by
its @radix-ui popover. Their versions are the ones the `yarn.lock` of the
excalidraw repository resolves at tag `v0.17.6`, and their license texts, copied
unchanged from each version's npm tarball (fetched 2026-11-14), are in
`LICENSES/MIT-excalidraw-bundled.txt`, one `==> name version <==` block per
package. The string quoted for each was found in `board-*.js`:

- @braintree/sanitize-url 6.0.2 (the pattern
  `/^([^\w]*)(javascript|data|vbscript)/im`): Copyright (c) 2017 Braintree.
- lodash.throttle 4.1.1 (the error "Expected a function" and the `maxWait`
  option): Copyright jQuery Foundation and other contributors. lodash.throttle
  carries its own copy of `debounce`; the bundle holds a single copy of that
  code, and the separate lodash.debounce package of the lockfile belongs to a
  development tool, not to the bundle.
- open-color 1.9.1 (the palette `"gray":["#f8f9fa","#f1f3f5",…]`): Copyright
  (c) 2016 heeyeun.
- png-chunks-extract 1.0.0 (the error "Invalid .png file header"): Copyright
  (c) 2015 Hugh Kennedy.
- tunnel-rat 0.1.2 (a store created with `current:new Array,version:0`):
  Copyright (c) 2022 Poimandres; and zustand 4.3.7, which it uses (the warning
  "[DEPRECATED] Passing a vanilla store will be unsupported in a future
  version. Instead use `import { useStore } from 'zustand'`."): Copyright (c)
  2019 Paul Henschel.
- aria-hidden 1.2.3 (the default attribute `data-aria-hidden`): Copyright (c)
  2017 Anton Korzunov.
- @floating-ui/core 0.7.3, @floating-ui/dom 0.5.4 and @floating-ui/react-dom
  0.7.2 (`getClippingRect`,
  `convertOffsetParentRelativeRectToViewportRelativeRect`): Copyright (c) 2021
  Floating UI contributors; with use-isomorphic-layout-effect 1.1.2, Copyright
  (c) Mateusz Burzyński, whose browser build is a bare alias of React's
  `useLayoutEffect` and leaves no trace of its own.
- react-remove-scroll 2.5.5 (`allowPinchZoom`, `noIsolation`, `shards`) and its
  dependencies: react-remove-scroll-bar 2.3.4 (the class names
  `right-scroll-bar-position` and `width-before-scroll-bar`),
  react-style-singleton 2.2.1 (a `<style type="text/css">` element given the
  page nonce), get-nonce 1.0.1 (that nonce), use-sidecar 1.1.2 (the error
  "Sidecar: please provide `sideCar` property to import the right car"),
  use-callback-ref 1.3.0, and detect-node-es 1.1.0, whose browser build is the
  constant `false`: Copyright (c) 2017 and 2020 Anton Korzunov, and (c) 2017
  Ilya Kantor for detect-node-es. The tarballs of react-remove-scroll-bar 2.3.4
  and react-style-singleton 2.2.1 ship no license file and declare MIT in their
  `package.json`; their blocks reproduce the MIT `LICENSE` that each
  repository (https://github.com/theKashey/) added after those releases
  (commits `7301c160fd` and `a9f1e49f01`); the first one's copyright line also
  gives the author's e-mail address, left out here.
- tslib 2.5.0, a dependency of use-sidecar (the helpers `__assign` and `__rest`:
  a `for(var k in o)Object.prototype.hasOwnProperty.call(o,k)&&e.indexOf(k)<0`
  loop followed by a `typeof Object.getOwnPropertySymbols=="function"` branch,
  right before the `right-scroll-bar-position` class name): 0BSD, Copyright (c)
  Microsoft Corporation (`LICENSES/0BSD-tslib.txt`, the `LICENSE.txt` of the
  tslib 2.5.0 npm tarball). Unlike the MIT packages above it is not in
  `LICENSES/MIT-excalidraw-bundled.txt`, since 0BSD is a different license.

## Excalidraw font Assistant — OFL-1.1

Files: excalidraw-assets/Assistant-*.woff2
License: OFL-1.1
License-File: LICENSES/OFL-1.1.txt

Copied from `@excalidraw/excalidraw@0.17.6`. The license of each file was read
from the font's own embedded name table (fields 0, 13 and 14), not guessed:

- `Assistant-Regular`, `-Medium`, `-SemiBold`, `-Bold`: "Copyright 2020 The
  Assistant Project Authors (https://github.com/hafontia/Assistant). Copyright
  2010 The Source Sans Pro Authors (https://github.com/adobe-fonts/source-sans-pro),
  with Reserved Font Name 'Source'." Licensed under the SIL Open Font License,
  Version 1.1 (`LICENSES/OFL-1.1.txt`, whose header carries these lines). Field
  13: "This Font Software is licensed under the SIL Open Font License, Version
  1.1."

## Excalifont, mapped to the whiteboard family Virgil — OFL-1.1

Files: fonts/Excalifont-Regular.woff2
License: OFL-1.1
License-File: LICENSES/OFL-1.1-Excalifont.txt

`fonts/Excalifont-Regular.woff2` (Excalifont, "Version 1.000;Glyphs 3.2 (3227)",
SHA-256 `ee41ec4c06bfa0728665499de6f4b4019e7953119ab20b5aeb5917f1609c3b2a`),
the complete font that https://plus.excalidraw.com/excalifont offers for
download, at
https://excalidraw.nyc3.cdn.digitaloceanspaces.com/fonts/Excalifont-Regular.woff2
(fetched 2026-11-13), unchanged. Excalifont is the hand-drawn font that replaced
Virgil in Excalidraw. Its license was read from the font's own name table, not
from a web page (that page's description says "MIT", its text says OFL-1.1):

- field 0: "Copyright (c) 2024 by Excalidraw. All rights reserved."
- field 13: "This Font Software is licensed under the SIL Open Font License,
  Version 1.1.", followed by the full OFL 1.1 text; field 14:
  "http://scripts.sil.org/OFL". No Reserved Font Name is declared.
- designer and manufacturer: "Your Own Font Foundry (Virgil); Ján Filípek /
  DizajnDesign (Excalifont, modifications)".

`LICENSES/OFL-1.1-Excalifont.txt` reproduces fields 0 and 13 as embedded. The
subset files of the Excalidraw repository (`packages/excalidraw/fonts/Excalifont/`)
were not used: the subsetter dropped fields 13 and 14 from them.

## Comic Shanns, mapped to the whiteboard family Cascadia — MIT

Files: fonts/ComicShanns2-Regular.ttf
License: MIT
License-File: LICENSES/MIT-comic-shanns.txt

`fonts/ComicShanns2-Regular.ttf` is `v2/comic shanns 2.ttf` of
https://github.com/shannpersand/comic-shanns at commit `b98eee0894`, unchanged
apart from the file name (SHA-256
`64590b794cab741937889d379b205ae126ca4f3ed5cbe4f19839d2bfac246da6`). Comic
Shanns is the monospace font that later Excalidraw releases use in place of
Cascadia. Its name table, field 13, is the MIT license text headed "Copyright
2020 Shannon Miwa"; the repository's `LICENSE` (`LICENSES/MIT-comic-shanns.txt`)
is the same MIT text with "Copyright (c) 2018 Shannon Miwa".

## xterm.js

Files: xterm.min.js, xterm.css, addon-fit.min.js
License: MIT
License-File: LICENSES/MIT-xterm.txt
License-File: LICENSES/MIT-xterm-addon-fit.txt

`xterm.min.js`, `xterm.css` (@xterm/xterm 5.5.0) and `addon-fit.min.js`
(@xterm/addon-fit 0.10.0), from https://github.com/xtermjs/xterm.js, under the
MIT license:

    Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
    Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
    Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.

The fit addon carries its own copyright line (2019); see its file in `LICENSES/`.
The web-links addon (@xterm/addon-web-links 0.11.0) is no longer shipped:
terminal links are matched by `terminal-links.js`, built from
`static/terminal-links.ts`, which reuses the addon's URL character classes.

The two `.js` files were downloaded from jsDelivr, which prepends a six-line
comment ("Skipped minification because the original files appears to be already
minified. Original file: /npm/@xterm/xterm@5.5.0/lib/xterm.js [...]"). After that
comment, each file is byte-identical to `lib/xterm.js` and `lib/addon-fit.js` of
its npm tarball; `xterm.css` is byte-identical to
`css/xterm.css` of `@xterm/xterm@5.5.0`. SHA-256 (`sha256sum -c` format, from
`static/vendor/`):

    4196e242ef1cf4c2adead8d97f4a772a69576076f70b095e004b4abbb049e7bf  xterm.min.js
    ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6  xterm.css
    a6a7bbb33569f16aa3e18d71425e34d035fc89a0b7e8cba084f8855f91aa38f1  addon-fit.min.js

## marked 14.1.4 — MIT

Files: marked.min.js
License: MIT
License-File: LICENSES/MIT-marked.txt

Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/); Copyright (c)
2011-2018, Christopher Jeffrey (https://github.com/chjj/). MIT license, full
text in `LICENSES/MIT-marked.txt`. https://github.com/markedjs/marked

`marked.min.js` is byte-identical to `marked.min.js` of the `marked@14.1.4` npm
tarball. SHA-256:

    0a0fbf5ea62f007e7ede02d6f75b4eb142ee8acb310cd957ed566af3304c0bcc  marked.min.js

## mermaid 11.17.2 — MIT

Files: mermaid.min.js
License: MIT AND ISC AND BSD-3-Clause AND Apache-2.0 AND Unlicense AND (Apache-2.0 OR MPL-2.0)
License-File: LICENSES/MIT-mermaid.txt
License-File: LICENSES/Apache-2.0.txt
License-File: LICENSES/MIT-js-yaml.txt
License-File: LICENSES/MIT-lodash-es.txt
License-File: LICENSES/MIT-cytoscape.txt
License-File: LICENSES/ISC-d3.txt
License-File: LICENSES/MIT-khroma.txt
License-File: LICENSES/MIT-marked.txt
License-File: LICENSES/MIT-roughjs.txt
License-File: LICENSES/MIT-mermaid-bundled.txt
License-File: LICENSES/ISC-mermaid-bundled.txt
License-File: LICENSES/BSD-3-Clause-mermaid-bundled.txt
License-File: LICENSES/Unlicense-mermaid-bundled.txt

Copyright (c) 2014-2022 Knut Sveidqvist (`LICENSES/MIT-mermaid.txt`, identical to
the `LICENSE` of the 11.17.2 tarball). https://github.com/mermaid-js/mermaid

`mermaid.min.js` is byte-identical to `dist/mermaid.min.js` of the
`mermaid@11.17.2` npm tarball (fetched 2026-11-14): tarball integrity
`sha512-V6K3C8EBdEsPFZXSKMJe6ppQOENxuHARr9GvHX4hh47lAbhMRD9qf4oEK7LoaRQxULMa80/qt5gHO73aCleBBg==`,
SHA-1 `e3caf3717582c0e44e5d04cff043e025caec7cba` (both as the registry publishes
them), and `mermaid.min.js` SHA-256
`581ed7d74bd9048d0e3a91363927d72ef22942d7722546b27f7cc29e35390eb8`. 11.10.0 and
later fix CVE-2025-54880 and CVE-2025-54881.

The bundle embeds dependencies; the ones that print a notice in
`mermaid.min.js` ("Bundled license information") are:

- DOMPurify 3.4.12, Cure53 and other contributors, Apache-2.0 OR MPL-2.0; used
  under Apache-2.0 (`LICENSES/Apache-2.0.txt`).
- lodash-es, Copyright OpenJS Foundation and other contributors, MIT, based on
  Underscore.js, Copyright Jeremy Ashkenas, DocumentCloud and Investigative
  Reporters & Editors (`LICENSES/MIT-lodash-es.txt`). Two builds are bundled,
  each printing the notice: 4.18.1 (dagre-d3-es, chevrotain-allstar) and 4.17.23
  (chevrotain); the `LICENSE` of both tarballs is that file.
- cytoscape, Copyright (c) 2016-2026 The Cytoscape Consortium, MIT
  (`LICENSES/MIT-cytoscape.txt`, identical to the `LICENSE` of the cytoscape
  3.34.0 tarball, the version the lockfile below resolves), with the thenable,
  jQuery-event, Bezier and spring notices printed in the bundle.

js-yaml is bundled without a notice line: the file holds its `YAMLException`
and its name. It is not a dependency of the npm package: the mermaid sources
import it for front matter and the build takes it from the repository root's
devDependencies (`js-yaml ^4.3.0`, resolved to 4.3.0, the version the source map
`dist/mermaid.min.js.map` names). MIT, `LICENSES/MIT-js-yaml.txt`, identical to
the 4.3.0 tarball's `LICENSE`. Its dependency argparse 2.0.1 (Python-2.0) serves
only the js-yaml command-line tool and is not in the bundle (absent from that
source map).

marked is also bundled, without a notice line: the file holds its error strings
("marked(): input parameter is undefined or null") and its report link
"https://github.com/markedjs/marked". `mermaid@11.17.2` declares `marked ^16.3.0`,
which the lockfile below resolves to 16.3.0, whose `LICENSE.md` is the same text. MIT, Copyright (c) 2018+, MarkedJS and
Copyright (c) 2011-2018, Christopher Jeffrey (`LICENSES/MIT-marked.txt`).

Other dependencies of `mermaid@11.17.2` are bundled without a notice in the
file. The versions are the ones `pnpm-lock.yaml` resolves at the tag
`mermaid@11.17.2` of https://github.com/mermaid-js/mermaid (it agrees with the
DOMPurify 3.4.12 notice the bundle prints and with the package versions the
source map `dist/mermaid.min.js.map` names), taking the runtime closure of
mermaid's dependencies and of `@mermaid-js/parser` 1.2.1. The parser now bundles
langium 4.2.1 and chevrotain 11.1.2 into its own `dist/` (they are its
devDependencies), so their closure is included; the source maps of the
`@mermaid-js/parser@1.2.1` tarball list what it takes from them. Each tarball
was checked against the lockfile's integrity. Each notice below is the license
file of that version's npm tarball, copied unchanged (fetched 2026-11-14), one
`==> name version <==` block per package:

- `LICENSES/MIT-mermaid-bundled.txt`: @braintree/sanitize-url 7.1.2,
  @upsetjs/venn.js 2.0.0, chevrotain-allstar 0.3.1, cose-base 1.0.3 and 2.2.0,
  cytoscape-cose-bilkent 4.1.0, cytoscape-fcose 2.2.0, dagre-d3-es 7.0.14, dayjs
  1.11.21, es-toolkit 1.45.1, fastdom 1.0.12, hachure-fill 0.5.2, @iconify/utils
  3.0.2, katex 0.16.47, langium 4.2.1, layout-base 1.0.2 and 2.0.1,
  path-browserify 1.0.1, path-data-parser 0.1.0, points-on-curve 0.2.0,
  points-on-path 0.2.1, strictdom 1.0.1, stylis 4.3.6, ts-dedent 2.2.0, uuid
  14.0.0, vscode-jsonrpc 8.2.0, vscode-languageserver-protocol 3.17.5,
  vscode-languageserver-textdocument 1.0.12, vscode-languageserver-types 3.17.5,
  vscode-uri 3.1.0. fastdom and strictdom (Copyright (c) 2016 and 2013 Wilson
  Page) ship no license file: their block is the MIT text of the "License"
  section of the tarball's `README.md`, from "(The MIT License)" to the end.
  path-browserify is not resolved through mermaid's dependencies: vscode-uri
  3.1.0's prebuilt `lib/esm/index.mjs` embeds it (its source map names
  `node_modules/path-browserify/index.js`; vscode-uri declares
  `path-browserify ^1.0.1`, whose only release in that range is 1.0.1).
- `LICENSES/ISC-mermaid-bundled.txt`: the d3 modules of d3 7.9.0 (d3-array
  3.2.4 to d3-zoom 3.0.0), delaunator 5.0.1, internmap 1.0.1 and 2.0.3; d3 itself
  is `LICENSES/ISC-d3.txt` (the d3 7.9.0 `LICENSE`).
- `LICENSES/BSD-3-Clause-mermaid-bundled.txt`: d3-sankey 0.12.3 and the older
  modules it pulls in (d3-array 2.12.1, d3-path 1.0.9, d3-shape 1.3.7), and
  d3-ease 3.0.1.
- `LICENSES/Unlicense-mermaid-bundled.txt`: robust-predicates 3.0.2.
- chevrotain 11.1.2 and its @chevrotain packages: Apache-2.0, whose tarball
  `LICENSE.txt` is byte-identical to `LICENSES/Apache-2.0.txt`.
- roughjs 4.6.6 (mermaid's build applies its own `patches/roughjs.patch`):
  `LICENSES/MIT-roughjs.txt`, identical to its tarball `LICENSE`.

A notice is reproduced for every package of that closure except the ones that
only run under Node.js or ship only types, which leave no code in a browser
bundle (the dependencies @iconify/utils uses to load icon sets from disk, the
d3-dsv and katex command-line tools, `@types/*`, `@iconify/types`), and
vscode-languageserver 9.0.1, which the parser's source maps do not list (they
list vscode-languageserver-protocol, whose browser entry and protocol method
names are in the file). Where the bundle's minified code leaves no trace of a
package of the closure, its notice is kept anyway.

khroma (`^2.1.0`) is MIT: its registry metadata carries no license field, but
the `license` file of the `khroma@2.1.0` npm tarball (repository
github.com/fabiospampinato/khroma) is the MIT license, "Copyright (c)
2019-present Fabio Spampinato, Andrew Maney", reproduced in
`LICENSES/MIT-khroma.txt`.

## highlight.js 11.10.0 — BSD-3-Clause

Files: highlight.min.js, hljs-github.min.css, hljs-github-dark.min.css
License: BSD-3-Clause
License-File: LICENSES/BSD-3-Clause-highlight.js.txt

`highlight.min.js`, `hljs-github.min.css`, `hljs-github-dark.min.css`, byte-identical
to `highlight.min.js`, `styles/github.min.css` and `styles/github-dark.min.css` of
the `@highlightjs/cdn-assets@11.10.0` npm tarball. SHA-256:

    471ef9ae90c407af440fcdc48edfeeb562106b3267bd12d99071c162fb52ed32  highlight.min.js
    3a9a5def8b9c311e5ae43abde85c63133185eed4f0d9f67fea4b00a8308cf066  hljs-github.min.css
    9f208d022102b1d0c7aebfecd8e42ca7997d5de636649d2b31ea63093d809019  hljs-github-dark.min.css

    Copyright (c) 2006, Ivan Sagalaev.
    All rights reserved.

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of the copyright holder nor the names of its
      contributors may be used to endorse or promote products derived from
      this software without specific prior written permission.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
    AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
    ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
    CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
    SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
    INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
    CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
    ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
    POSSIBILITY OF SUCH DAMAGE.

## DOMPurify 3.4.16 — Apache-2.0 OR MPL-2.0

Files: purify.min.js
License: Apache-2.0 OR MPL-2.0
License-File: LICENSES/Apache-2.0.txt

`purify.min.js`, the standalone build `dist/purify.min.js` of the npm package
`dompurify@3.4.16`, fetched 2026-10-01 from
https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.min.js and checked
byte-identical to the file in the npm tarball (tarball integrity
`sha512-sqo+pNp3qRhCIpbgRi1y8Tgk27Bo2Ry7w0dC1NBeNTdZChWjz9Xb/KOoZbRP/R6pQZ80Qw8YhXw13hWWBbMRnQ==`).
File sha256 `2c90a9b46d6463f26038a29b686e82bc91de01fdac9d5229e7cfe3b360134ea2`
(checked by `tests/test_view_markdown.py`).

    Copyright (c) Cure53 and other contributors.
    Dual-licensed under the Apache License, Version 2.0 and the Mozilla Public
    License, Version 2.0; this project uses it under the Apache License 2.0
    (full text in `LICENSES/Apache-2.0.txt`).
    https://github.com/cure53/DOMPurify/blob/3.4.16/LICENSE

## Monaco Editor 0.52.2 — MIT

Files: monaco/LICENSE, monaco/ThirdPartyNotices.txt, monaco/vs/**
License: MIT AND (Apache-2.0 OR MPL-2.0)
License-File: static/vendor/monaco/LICENSE
License-File: static/vendor/monaco/ThirdPartyNotices.txt
License-File: LICENSES/Apache-2.0.txt
License-File: LICENSES/MIT-marked.txt

`monaco/vs/` (trimmed `min` build: loader, base, editor, basic languages, the
json language service and the css/html language clients; translations, the
css/html workers and the TypeScript service left out,
`language/typescript/tsMode.js` is a session-mesh stand-in).
Copyright (c) 2016 - present Microsoft Corporation. MIT license, full text in
`monaco/LICENSE`. https://github.com/microsoft/monaco-editor

`monaco/ThirdPartyNotices.txt` is the notice file of the `monaco-editor@0.52.2`
npm package, copied unchanged (it covers code that Monaco's full distribution
incorporates, among them the Node.js path library, marked, JS Beautifier and
the TypeScript service; this trimmed build leaves out the TypeScript service).

`monaco/vs/editor/editor.main.js` is byte-identical to `min/vs/editor/editor.main.js`
of the `monaco-editor@0.52.2` npm tarball and embeds:

- DOMPurify 3.1.7, with its own notice in the file ("@license DOMPurify 3.1.7 |
  (c) Cure53 and other contributors | Released under the Apache license 2.0 and
  Mozilla Public License 2.0"); used under Apache-2.0 (`LICENSES/Apache-2.0.txt`).
- marked, as the module `vs/base/common/marked/marked` (with its "marked(): "
  error strings): MIT, Copyright (c) 2018+, MarkedJS and Copyright (c)
  2011-2018, Christopher Jeffrey (`LICENSES/MIT-marked.txt`, the same text as the
  markedjs entry of `ThirdPartyNotices.txt`); the version is not recorded in the
  file.

Not shipped, under the rule at the top: `vs/language/css/cssWorker.js` and
`vs/language/html/htmlWorker.js` of the `monaco-editor@0.52.2` tarball. Their
completion and hover data is built from MDN content distributed under CC BY-SA
2.5 (the READMEs of `vscode-css-languageservice` 6.2.14,
`vscode-html-languageservice` 5.2.0 and `@vscode/web-custom-data` 0.4.9, which
these workers bundle, and the `LICENSE.md` of https://github.com/mdn/content),
and section 4(b) of CC BY-SA 2.5 allows a derivative work only under that
license or one with the same License Elements, which the GPL is not.
`static/code.html` turns off every CSS, LESS, SCSS, HTML, Handlebars and Razor
language feature that would start these workers (`setModeConfiguration({})`);
`cssMode.js` and `htmlMode.js`, client code without that data, stay, and the
viewer still colours these languages with the Monarch grammars of
`vs/basic-languages/`.

### SHA-256 of the Monaco files

Every file under `monaco/`, the codicon font of the next section included
(`sha256sum -c` format, from `static/vendor/`). All are byte-identical to the
same path of the `monaco-editor@0.52.2` npm tarball (`vs/` under its `min/`),
except the stand-in `vs/language/typescript/tsMode.js`.

    33e4ff1a06ef62ba21788ea162564ee8165269a24a9ce6ef301837447eab0ac6  monaco/LICENSE
    790537262fc78a764e121e6b92b959bcd3f5c310b47d9d9b9e92e17fe0af5336  monaco/ThirdPartyNotices.txt
    0f1d5219934e96e83b8db162d60b4d8c09b5de1e7d38031cbafe4a3c0f2889c9  monaco/vs/base/browser/ui/codicons/codicon/codicon.ttf
    dbe4aa4f2874f5768e8d98e94281667c0bc493e02dd9760adca930699ff3279b  monaco/vs/base/worker/workerMain.js
    dc732450731b12d051879da8f2338fa30168af60c8fdbe60bfadfe74068b4d7b  monaco/vs/basic-languages/abap/abap.js
    96d67c25a6cdf6ade6542e737cead9f6441d2d8bcae85d2989d44477ef276165  monaco/vs/basic-languages/apex/apex.js
    579b894877cdded3c2c6b8ef90a30ece802fbed44d9dab9ae12221a4be485e9a  monaco/vs/basic-languages/azcli/azcli.js
    75cbd235b127d3eef0a6b90cd83edc049cb264381971cba3d0fce660f9e5a68f  monaco/vs/basic-languages/bat/bat.js
    94fb7442cec7b669ff87aeb58d0d7c264830f0bd72072647b563d4c49698f48a  monaco/vs/basic-languages/bicep/bicep.js
    b667c861eeb35eca8dd39ebe952a251c66e104267cd16344856a6cd6c1e88c57  monaco/vs/basic-languages/cameligo/cameligo.js
    1ac122e851515c788c65589dfabe18fa40b03a90d67b6c835bf27fdd678d8fc5  monaco/vs/basic-languages/clojure/clojure.js
    4756a8c0d68cc19b2490403f39b22bcf3a518364eace045eaf87ca36fc7a3124  monaco/vs/basic-languages/coffee/coffee.js
    52124e8e802797f89ca8e4415c6b9d63a55264de54ea1b38b5aa663159c46c1b  monaco/vs/basic-languages/cpp/cpp.js
    efe2ca37b83f691348ccfa1b310fe4ddd1f42653fe13f4354e4e724e39153e95  monaco/vs/basic-languages/csharp/csharp.js
    4b05496f741b764550cddb54651233e618e2aed867e4891fd2575191a10cc4fe  monaco/vs/basic-languages/csp/csp.js
    92220aad32d0a817016e500ff7f7d1b072d6c8c36367742c133f83882c1b7ffe  monaco/vs/basic-languages/css/css.js
    00135bea5372b4c0e8cf411b18853968e39f041605bf5252a2c8105849d6fb9c  monaco/vs/basic-languages/cypher/cypher.js
    9ed4583d2ad0605822f006d25c04525e5869891f884808a43c79c1a96b658473  monaco/vs/basic-languages/dart/dart.js
    0de466e07b2045975ebdfe8ee61fc6adeba7aa5a36bb7bb0b1532762650fb342  monaco/vs/basic-languages/dockerfile/dockerfile.js
    0d9dd1b6eb7dd32d114d3ed87803afb1216ce9bd917dedc37f32bb139292ddc7  monaco/vs/basic-languages/ecl/ecl.js
    89f7bd4629f8261e33fed69c2efddcd66d01b8346392ac74c453e2116e809dd9  monaco/vs/basic-languages/elixir/elixir.js
    9982918be402c06f9c703345648f7bc625d38eb9b15da88124d79418217575ba  monaco/vs/basic-languages/flow9/flow9.js
    6a9b441e058915a320129a4ab64c5778cf99ffc2b7f6661b7ca5a07d2a434efa  monaco/vs/basic-languages/freemarker2/freemarker2.js
    f53a2d0921e03d232f07f0014cdd07d99558ad98d3478717ccd74e968434248c  monaco/vs/basic-languages/fsharp/fsharp.js
    b94f30b9854f995a608da2bac17802da8cc83234a34b374b307569df850ec839  monaco/vs/basic-languages/go/go.js
    5bab64815245a9e79fe922f0d010d5028395f31c92b3aa4e187113c968b6c58b  monaco/vs/basic-languages/graphql/graphql.js
    55f04266be83009aebd6b25a5fa46452f524c99d17ad17c4b18c24b8e6f89496  monaco/vs/basic-languages/handlebars/handlebars.js
    14b490d77d2d02678b17ae34b1796f5fa31a32be2569f834b65b60a429bf97bf  monaco/vs/basic-languages/hcl/hcl.js
    001b44bd88d864aa5cd165d2c326d0ea253f80647a88b92683759eaee4b0702d  monaco/vs/basic-languages/html/html.js
    25e9a52de4fd77a5f87bf22baa94703d2bcee82d119f93cf58921a751f3c203f  monaco/vs/basic-languages/ini/ini.js
    f5a6e854d70a317188bdc3000928665d811bc1ad63237312f8954e10037a28b1  monaco/vs/basic-languages/java/java.js
    169988c69c81eeccdd58435c502efcb7d6c1a667da072f0bba3a0022f8b85e46  monaco/vs/basic-languages/javascript/javascript.js
    03319b1c3b9d780c9ec06575a2c349d5e48f262bd7af42716007efbccdb563ed  monaco/vs/basic-languages/julia/julia.js
    d736176b14856a1ebb09bdfd043a898da4b97cc3c5145b0996832f8ef73baa1c  monaco/vs/basic-languages/kotlin/kotlin.js
    47c17c686d409d11023d1b9e470d7e4c4971d8418fe6ffb6d7844a8f27a6c979  monaco/vs/basic-languages/less/less.js
    d97e007cca8271a087222884eb94e9b17b2b02eaca0c933888ee2e2d773afd78  monaco/vs/basic-languages/lexon/lexon.js
    47765d89a06e1c9d06895c35249534dfcad1b748a039e8ffc0ac66f97d456b8f  monaco/vs/basic-languages/liquid/liquid.js
    5d46959daacfc940fc177d59e1dcf75fc18b0aa3d0ccf18594316c297c71da86  monaco/vs/basic-languages/lua/lua.js
    b8301f00a5efd7104ce3166542ba0b544e477999509d0c646133de9625fd7a3a  monaco/vs/basic-languages/m3/m3.js
    0e3ddec8d09da9e89b0e8f46786f30b781982f759f29c5e6c22b0b4b00acae78  monaco/vs/basic-languages/markdown/markdown.js
    f7969b7c567c43ced6303da0f5c080c97d65b09932ca2ec56bb406c0074bcf6f  monaco/vs/basic-languages/mdx/mdx.js
    52628efb022d4042fd4986eb25573e7c57761a58927ca7692aeed0d63cc8943a  monaco/vs/basic-languages/mips/mips.js
    5f419eb81cb11ebda7a368724a2fba75e5b75489ae5aee64e358077959205659  monaco/vs/basic-languages/msdax/msdax.js
    5516f47c461e3c2db7bf70bb061c80011bd57e3db48da5a407f62a8681a49d85  monaco/vs/basic-languages/mysql/mysql.js
    ac02b80f4ecaf3650cac477ce9f9fc810d7dfc9083805adeba6b272c85548712  monaco/vs/basic-languages/objective-c/objective-c.js
    9bef71e3ff29a179df2f36090501f30719c4d20156b943cbfbbd719898743dd4  monaco/vs/basic-languages/pascal/pascal.js
    b46f6456a71622af82592bfec7aaf68e3d71d1d3792f8153f9f2e62b1e3fe1f0  monaco/vs/basic-languages/pascaligo/pascaligo.js
    ed897b714002e7089e1c10074e3694db1d4d702ebb52cf84de63bd9e093f9add  monaco/vs/basic-languages/perl/perl.js
    08d8e6d366aec43961a38fe17142f44339752b05928c68a35c65de90f930ddd5  monaco/vs/basic-languages/pgsql/pgsql.js
    ce048845100cdc880feb2e6d13474eb9963bb0e76beb6d7a9363d25acd6c44c8  monaco/vs/basic-languages/php/php.js
    20f527dafd1b353840ba7f0b1dde986474b106a18e859eac8ef0b46cb1adf8a2  monaco/vs/basic-languages/pla/pla.js
    da8833778aab6f7d9ea0ab7349d0e1b10739a3c8e1e712c4fe01bd0323f8da9e  monaco/vs/basic-languages/postiats/postiats.js
    3270ec1992045a0fedeef66cbb14245c8183dc5f12cd4dfe71dd21eeeda48da9  monaco/vs/basic-languages/powerquery/powerquery.js
    948d8bccfa1045b07b87f1d8f9c9058a507d2a167aad14f3b83c64b6523e588c  monaco/vs/basic-languages/powershell/powershell.js
    1ec0534959a0499a9165892506f98c465cdc9a7c25ad3868a20e9c99e71db335  monaco/vs/basic-languages/protobuf/protobuf.js
    158264e710b017168f70696b910e47585f0b81358d65f5cd934f46b23b71c02a  monaco/vs/basic-languages/pug/pug.js
    043c66f7b48025022bd6fc15db72ea18d566534c4e8859774e6f52f23210d720  monaco/vs/basic-languages/python/python.js
    6d718f23d8606e554dbfe1fccaedfb991d9abb5234ab846f034af3c93d75a287  monaco/vs/basic-languages/qsharp/qsharp.js
    b717d83cb4dfd7129826e2d9d42e39a5e099b49b434b2bfab85de3e3a459dc65  monaco/vs/basic-languages/r/r.js
    1887bd1f50cd42c344ca2060eb6c3faa60bb2d9f554880c8924c80d6d8084046  monaco/vs/basic-languages/razor/razor.js
    f7a90a1c8e21b8ab30fff50986acbcc9ac83f2574729dada292f65243841377b  monaco/vs/basic-languages/redis/redis.js
    b566247e8c2d17fabb0b31b072487bc9631420899b829d8d26ea3f9c6b564527  monaco/vs/basic-languages/redshift/redshift.js
    ff914084b03c669e101d35406a65b5d1f3b1ce2415a1d9c4201fb941546361e5  monaco/vs/basic-languages/restructuredtext/restructuredtext.js
    69da50c3194c76a3530dc36309ea85a933c75aa9e7058cf29e7516ac80951729  monaco/vs/basic-languages/ruby/ruby.js
    37dc707b3ea97d761a3bab49359d32fd7b641f58bad4e2fd8c4c1cd0800cb4d2  monaco/vs/basic-languages/rust/rust.js
    acfd18f27b1cc052d78cb7a762ba9502e9fd4d9292e7e2b271302a8377a445bb  monaco/vs/basic-languages/sb/sb.js
    d513b09bbfbc050b372beac78e2584608212046ad068a08f8ab4e0dd1207b621  monaco/vs/basic-languages/scala/scala.js
    8b78b406fbe3040658387262678eeb00e2029c7a767a4212590130ae0686551d  monaco/vs/basic-languages/scheme/scheme.js
    6cf67bc2644efec58329cf02036c11215524007fe09ac2460ab46989bc6ae3cf  monaco/vs/basic-languages/scss/scss.js
    fd62075e804809482b0ffa432f40b927564527fc4150f5251072e8ac455a6886  monaco/vs/basic-languages/shell/shell.js
    5dee98e9f5a38c98589fdbc594f9f5461f7ec9792d76ede6270218e77ebc75e9  monaco/vs/basic-languages/solidity/solidity.js
    3e3f4067b39cc667b3bac7da769dd811650c7c9dc9e074362ab7e7d1c5b47c5f  monaco/vs/basic-languages/sophia/sophia.js
    da82319ca8f88c2cca55b324b07390b558669b1b96cd540cf808425c1b9faca5  monaco/vs/basic-languages/sparql/sparql.js
    17d3fa62658c8d29a806dbf786b8b5f90f913845daa18b24896710164a1661d8  monaco/vs/basic-languages/sql/sql.js
    9607a2e6eef6cc1a195b23885a7138b539f1b08b83033769ec4a130c8d42d649  monaco/vs/basic-languages/st/st.js
    cdc358689959b892a4b0a0d284e405adc22603bf9a8202fd8d4d1e4a0d16ae9a  monaco/vs/basic-languages/swift/swift.js
    c570635e92cfe48a6795319a366b550126126d23277d6157aa58b260a3e34f84  monaco/vs/basic-languages/systemverilog/systemverilog.js
    44ae6a3a45937c23d03704880a81acb3bcc1f511303b0d8105ff68a68db1e1a7  monaco/vs/basic-languages/tcl/tcl.js
    d24fa72811b4a2f80b4f596f78042c03045df005c80ff9716693ce4b1b5ce409  monaco/vs/basic-languages/twig/twig.js
    c4da8cd5fa6ea11fb7e9734f512b848877c1b5bf7f0faea76402ceb4da618887  monaco/vs/basic-languages/typescript/typescript.js
    4e0eddfae2fc8524a552056f6f7efa2b4d0fe422952664fbe1c5bcc0493c84d1  monaco/vs/basic-languages/typespec/typespec.js
    93fbb1402356f40341924c2de339c9def343b949220ef065cca9f97ee896a30d  monaco/vs/basic-languages/vb/vb.js
    b5044b6ae1d2c58fa4c3a944c3d52632a88366bc0f22aa4e2e0e8da12e727f8e  monaco/vs/basic-languages/wgsl/wgsl.js
    d5cc3332e96b3300636a1677e535d16e8fa444538dcea17abe7b7ccdba6aab55  monaco/vs/basic-languages/xml/xml.js
    f4407dcc5601eec349552548557f3656a907b094575e7395402390aa08f8d7f2  monaco/vs/basic-languages/yaml/yaml.js
    857bc0beafefbcc83ab5cf3510e929391c0314add43ee1a4cb8ecaf4726abbac  monaco/vs/editor/editor.main.css
    90b588bc0b624e24052a576e1bcab2eaffec7bc666895188862eebd9c9745782  monaco/vs/editor/editor.main.js
    4d30d446fe1afe1e93325c6e2f363e67f4ca402fec5fccbb66b9a6342b191930  monaco/vs/language/css/cssMode.js
    0766d33510c464c14f09607a8fe85c1925c0b827844b72a87742e9b37af310bb  monaco/vs/language/html/htmlMode.js
    9200ffce4ac390675f6cb4c64ffaf4b4d8e650d3888caf631709cb136615e379  monaco/vs/language/json/jsonMode.js
    4b197c4165e356a04857e9317ec3d536fdbb92b91077bc483590c4f51056e3df  monaco/vs/language/json/jsonWorker.js
    08763de40009b226f6cd4556d3515d40b486ca70deba0f84de512e631e8a45d0  monaco/vs/language/typescript/tsMode.js
    28f3584fd04b182dfce15a9a1ce35b25bea22b31464aee500372bed18b7fee1a  monaco/vs/loader.js

## Monaco codicon font — CC-BY-4.0

Files: monaco/vs/base/browser/ui/codicons/codicon/codicon.ttf
License: CC-BY-4.0
License-File: LICENSES/CC-BY-4.0.txt

The icon font of Visual Studio Code (font name table: "codicon, Version 1.11,
The icon font for Visual Studio Code"). The font file embeds no license. The
`@vscode/codicons` npm package that publishes this font declares
CC-BY-4.0 for its content (its `LICENSE`, Copyright Microsoft Corporation, and
README), and MIT for its code. Evidence level: the `codicon.ttf` here is
byte-identical to the one in the `monaco-editor@0.52.2` npm tarball, but is not
byte-identical to any `@vscode/codicons` release checked (0.0.25 to 0.0.29 and
0.0.32 onwards), so the attribution rests on the font's origin, not on a hash
match. Attribution: codicons, Copyright (c) Microsoft Corporation, licensed
CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/); no changes were made
by this project. The text is `LICENSES/CC-BY-4.0.txt`.
