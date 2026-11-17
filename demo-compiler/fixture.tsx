// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

const escape = '<img src="/sink">';
const network = (() => {
  try { fetch('/sink'); return 'network worked'; }
  catch (error) { return error.name; }
})();
globalThis.__mesh_result = (timeMs) => <column>
  <heading text="Isolated TSX demo" />
  <text text={escape + ' · ' + network} />
  <card><badge text="Local iteration" /></card>
  <row><gear angle={Math.floor(timeMs / 10) % 360} /><gear angle={(360 - Math.floor(timeMs / 10) % 360) % 360} /></row>
</column>;
