# demo-runtime: experimental modules, not used by the service

This directory holds dependency-free JavaScript modules for a possible future kind of demo, in
which compiled agent code would run in a browser Web Worker and hand back a view tree for the page
to render. **Nothing in session-mesh loads them**: no route, pane, MCP tool or service uses them,
and the demos you see in the interface are the declarative scenes described in
[docs/demo-scene-v0.md](../docs/demo-scene-v0.md). They are kept with their tests so that the
format contracts stay checked.

| Module | Role |
|---|---|
| `view-codec-v0.mjs`, `view-codec-v2.mjs` | Strict decoders of a bounded JSON view tree. They refuse duplicate keys, malformed Unicode, control and bidirectional-format characters, and non-canonical numbers; the page renders only fixed elements, with text set through `textContent`. `view-codec-v2.mjs` is generated from `static/demo-view-contract.ts` and adds the `gear` node. |
| `worker-protocol-v0.mjs`, `worker-protocol-v2.mjs` | The messages between the page and a worker: one `init` bound to the code's digest, then numbered `frame` messages, then `close`. Any unknown field, replay, gap, reordering or digest mismatch closes both sides for good. The protocol gives the worker no callback into the page and no mesh data. |
| `admission-record-v*.mjs`, `catalog-v*.mjs`, `packet-v*.mjs`, `input-codec-v1.mjs` | Decoders of the records that would describe which compiled code may run for which demo revision, with fixed limits. They check every field against values pinned by the caller, and grant no right to run anything. |
| `test-*.mjs` | Node tests of the modules above, on shared test vectors. |

`npm run check:demo-runtime` runs the view, protocol, admission and packet tests;
`npm run check:demo-input` runs `test-input-schema-vectors.mjs` with the input contract checks.
