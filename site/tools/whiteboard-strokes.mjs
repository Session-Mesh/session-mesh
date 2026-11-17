// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Prints the two SVG groups of the whiteboard mock, with hand-drawn strokes:
// every line is drawn twice with a small seeded wobble, as rough sketch
// renderers do. Deterministic, so the output can be regenerated.
let seed = 20261115;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const jitter = (amount) => (rand() - 0.5) * 2 * amount;
const fmt = (n) => n.toFixed(1);

// One wobbly stroke from a to b, bowed through a displaced midpoint.
function stroke(a, b, wobble = 1.3) {
  const [x1, y1] = [a[0] + jitter(wobble), a[1] + jitter(wobble)];
  const [x2, y2] = [b[0] + jitter(wobble), b[1] + jitter(wobble)];
  const mx = (x1 + x2) / 2 + jitter(wobble * 1.6);
  const my = (y1 + y2) / 2 + jitter(wobble * 1.6);
  return `M${fmt(x1)} ${fmt(y1)} Q${fmt(mx)} ${fmt(my)} ${fmt(x2)} ${fmt(y2)}`;
}
const twice = (a, b, wobble) => `${stroke(a, b, wobble)} ${stroke(a, b, wobble)}`;
const path = (d) => `          <path class="draw" pathLength="1" d="${d}"/>`;

function box(x, y, w, h) {
  const corners = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  return path(corners.map((c, i) => twice(c, corners[(i + 1) % 4])).join(" "));
}

// A curved arrow from a to b through the control point c, with a two-line head.
function arrow(a, c, b) {
  const curve = () => `M${fmt(a[0] + jitter(1))} ${fmt(a[1] + jitter(1))} Q${fmt(c[0] + jitter(2))} ${fmt(c[1] + jitter(2))} ${fmt(b[0] + jitter(1))} ${fmt(b[1] + jitter(1))}`;
  const angle = Math.atan2(b[1] - c[1], b[0] - c[0]);
  const head = (turn) => [b[0] - 11 * Math.cos(angle + turn), b[1] - 11 * Math.sin(angle + turn)];
  return path(`${curve()} ${curve()} ${twice(head(0.45), b, 0.6)} ${twice(head(-0.45), b, 0.6)}`);
}
const text = (x, y, label, cls = "") => `          <text class="board-text${cls}" x="${x}" y="${y}" text-anchor="middle">${label}</text>`;

const user = [
  box(22, 110, 108, 56), box(206, 110, 108, 56), box(390, 110, 108, 56),
  arrow([138, 138], [168, 133], [198, 138]), arrow([322, 138], [352, 143], [382, 138]),
  text(76, 144, "browser"), text(260, 144, "api"), text(444, 144, "db"),
  `          <text class="board-text board-title" x="22" y="64">request path</text>`,
];
const agent = [
  box(298, 214, 110, 52),
  arrow([270, 172], [280, 204], [300, 216]), arrow([406, 216], [428, 204], [438, 174]),
  text(353, 246, "cache"), text(352, 126, "on miss", " board-note"),
];
const attrs = 'fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
console.log(`        <g class="board-user" data-board-step="0" ${attrs}>\n${user.join("\n")}\n        </g>`);
console.log(`        <g class="board-agent" data-board-step="3" ${attrs}>\n${agent.join("\n")}\n        </g>`);
