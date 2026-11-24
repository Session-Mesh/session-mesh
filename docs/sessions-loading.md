# Progressive loading of the session list

> **Status: implemented.** The client side described here is in the modules below, wired in
> `static/app.js`. The server side is the background-list server, whose contract is
> [docs/sessions-api.md](sessions-api.md). The client tolerates the absence of every field below; a
> server that sends none of them gives complete answers whose rows are all ready.

## What the page does today

- **One request at a time per tab.** The page polls `GET /api/sessions` without ever starting a
  request while the previous one is pending. While answers are quick, a request starts every 4 s
  (every 1 s while the server says its listing is incomplete). After a slow answer, the page stays idle
  at least as long as that answer took, up to 60 s. An explicit refresh
  (after a rename, a drop, a closed terminal, a new, adopted or resumed session) made during a request
  waits for one follow-up request that every such caller shares. An explicit refresh never sends
  `since` (below), so its answer holds the change the caller just made.
- **A hidden tab polls less.** While the tab is hidden, no request starts sooner than 30 s after the
  previous one. Becoming visible, or the browser's `online` event, asks for the list at once; the
  `offline` event shows "offline" in the status line.
- **Failures are visible, and told apart.** After a failure, the next attempt follows a bounded
  backoff (2, 4, 8, then 15 s). The status line says what happened and offers "Retry now"; the time
  of the next attempt is shown beside the message. A network error or a 502, 503 or 504 is "server
  unreachable". A request that gets no answer within 180 s is aborted and shown as a slow server, not
  as a restart. An error in the page's own handling of an answer is shown as a page error; it does
  not change what the line says about the server.
- **ACK-capable terminals need not wait for the list.** The page restores saved panes at once. A
  positive cached ACK hint paired with a valid `created` identity opens only an ACK-bound
  `/ws/{name}` socket; it cannot choose raw input or replay uncertain bytes. Missing, malformed or
  stale hints never fall back to raw: an old incarnation is detached when a different one is listed.
  A cached ACK attachment with the same identity is not downgraded if a later listing omits ACK.
  A legacy attachment is possible only from a separately observed live row with no ACK attempt for
  that actor; a legacy cached row waits for the listing. Until the first answer, the sidebar shows
  the sessions this device knew at its last listing, marked as loading. An answer that lists nothing
  yet (an empty `mesh`, `complete: false` and `management.state: "pending"`, as a server answers before its first
  listing) does not replace them, and the status line keeps saying "loading". A saved board adds
  the session it belongs to. The first observed listing settles the restored panes: a session it does
  not list is shown as unavailable, and its place in the layout is kept; a pane the owner has moved
  to something else meanwhile (a history card) is left as it is. Requests to open a pane are handled
  once the saved panes are restored. A pane's "More" menu opened before a listing names its session
  shows its entries unavailable (`aria-disabled`), runs nothing from them and holds no page reload,
  and enables them when that listing arrives.
- **A phone line before the list.** A line sent from the phone's field before a listing names the
  pane's session is held, the field read-only, and the status says that nothing has been sent yet. It
  waits through the listings while the pane is still unnamed (a skeleton listing after a server
  restart names nobody), at most 5 s. It is sent only to the pane, session and view where Enter was
  pressed: if the pane shows another session meanwhile, or the wait runs out, nothing is sent, the
  text stays in the field and a message says why. Cancel (in the status, or in the reload hold)
  ends the wait at once and keeps the text. What depends on the session's description (the mailbox
  button of an agent session) appears with that listing.
  The page's start (`localMesh` in `static/local-entry.js`) resolves once the first listing has been
  applied or has failed: a browser test that needs the server's listing awaits it, and `refresh()`
  resolves when the answer it asked for has been applied (the sidebar is drawn on the next frame).
- **Batched, keyed drawing.** Answers are drawn at most once per animation frame. Rows whose markup did
  not change keep their DOM node. Above 200 rows, each run of rows renders only what is near the
  viewport, between spacers that keep the scroll height. The row that holds the focus, the row being
  renamed and the row being dragged are always rendered, never moved or replaced while the list
  scrolls; one far from the viewport is rendered alone, between spacers. Tab walks every row.
- **Rows outside the window are not in the document.** Above 200 rows, find-in-page does not find a
  row that is not drawn, and assistive technology does not list it. The filter box above the list
  searches every session, drawn or not, and is the way to find one. The rows are buttons, not items of
  an ARIA list, so they carry no `aria-setsize` or `aria-posinset`.

The sessions known on this device are kept in `localStorage` (`mesh.knownSessions`): names, the
owner's own labels, folders, working directories, agent type and conversation id, activity
rounded to the minute, and only a positive ACK hint bound to a positive `created` identity. They
never include negative/legacy capability, what an agent said or a title derived from a conversation
(a session without an owner label is shown by its name until the list arrives). They are removed when
the owner signs out from this page and on a refused listing (HTTP 401). Both also record the time
(`mesh.signedOutAt`): a page started before it, in any tab of the browser, never stores them again,
even if one of its answers arrives after the sign-out. A stored value is read back as
untrusted input: every field is type-checked and bounded, the agent type must be one the server
reports, and a row that fails is dropped.

Modules (bundled into `static/sessions-progress.js`, global `MeshSessionsProgress`):

| Module | Job |
|---|---|
| `single-flight-poller.ts` | The generic poller: one request in flight, shared follow-ups, cadence, backoff, outcomes. |
| `page-signals.ts` | Hidden tab, `online` and `offline`, for any poller. |
| `sessions-contract.ts` | Every progressive field name of `/api/sessions`. |
| `sessions-status.ts` | Which status line to show. |
| `status-line-view.ts` | Drawing a status line, live region rules, the per-second tick. |
| `known-sessions.ts` | What this device keeps between loads, and its validation on read. |
| `sessions-priority.ts` | The `focus` order. |
| `host-silence.ts` | The rows kept while the PTY host is silent. |
| `open-replay.ts` | Which pane-open requests a page handles on load. |
| `keyed-render.ts` | The generic keyed morph and frame batcher. |
| `list-window.ts` | The generic window over a long list. |

## Server fields the client reads

All the field names are read in one file, `static/sessions-contract.ts`, so that renaming one costs a
change there only.

### Request

| Field | Where | Meaning |
|---|---|---|
| `since` | query | The `generation` of the last listing the page applied. Sent only after the server has sent a `generation`, and only by the periodic poll. An explicit refresh sends none: the background-list server answers a `since` request at once from its last published list and asks for no read of the PTY host's list, while a request without `since` waits (at most 2 s) until a read of that list started after it is published, so a session the caller just created is listed, as a `ready: false` row until a round describes it. |
| `focus` | query | Up to 64 session names, comma-separated, most wanted first: the panes on screen (the active one first), pinned conversations that run now, recently active sessions, then the rows visible in the sidebar. The URL stays under about 4 KiB. Sent only after the server has sent a `generation`. The background-list server ignores it (each round describes every session); it is kept for a server that reads it. |

An older server, or a test fixture, therefore keeps receiving exactly `GET /api/sessions`.

Pins are stored only in the browser and name conversations (agent and conversation id). The page
translates them into session names with each row's `agent.session_id`, including the provisional one
of a skeleton row.

### Response, top level

Every field below is optional. The background-list server (`docs/sessions-api.md`) sends
`generation`, `full`, `removed`, `complete`, `counts`, `host` and, per row, `ready`. It never sends
`phase`, a per-row `state` or `priority`; without them the page derives everything from `ready`,
`complete` and `counts`. It ignores `focus` and does not echo it.

| Field | Type | Client use |
|---|---|---|
| `generation` | integer ≥ 0 | Enables `since`/`focus`. An answer whose generation is lower than the `since` sent (the server restarted) is applied as a full listing. Requirement on the server: see below. |
| `removed` | array of names | In an answer to `since`: sessions gone since then. |
| `full` | `true` | Optional: the answer to `since` is complete anyway. |
| `complete` | boolean | `false`: the page polls with a 1 s base instead of 4 s, and never faster than the server answers. |
| `counts` | `{total, ready, …}` | The "N / M ready" detail of the status line. Ignored if `ready > total`; then the rows are counted. |
| `phase` | `"focus"`, `"recent"`, `"rest"` | Optional (not sent by the background-list server). Named in the status message. Any other value (`"done"`) is ignored. |
| `host` | `"ok"`, `"silent"`, `"restarted"` | `"silent"`: the server's last read of the PTY host's list failed, or one has been pending for over 1 s; see below. `"ok"` again after a successful read. `"restarted"`: an information line. |
| `management.state` | `"pending"` | The listing is a skeleton: its rows are not authority (no pane identity, no close, rename or filing, no drag). |
| `opens` | array | Pane-open requests. The page sets the cutoff of the opens it does not replay from the first answer that carries this array; an answer without it (one sent before the PTY host has listed anything) sets none. |

**A silent PTY host.** A server either lists no session while its host is silent (the current one), or
keeps listing the rows of its last listing (`host: "silent"`, the background-list server). Either way,
the rows on screen are the last known ones: each is marked unreachable, and none can be closed, renamed,
filed or dragged. A server may call its host silent after a short wait (1 s for the background-list
server, `docs/sessions-api.md`), so a single silent answer that still lists rows may be an ordinary slow round: the page believes
the silence after two consecutive silent answers, or 3 s after the first one, so that neither the rows
nor the status line flicker. An empty silent listing has nothing else to show and is believed at once.

Without `host`, the client also reads a silent host from `management.state === "unavailable"` or
`ptyhost === false`, which the current server already sends.

**A full answer to `since` must say `full: true`.** The page takes an answer to `since` for a delta
whenever its generation is at or above that `since` and it does not carry `full: true`. A higher
generation alone does not make an answer a valid delta: a server that cannot produce the changes
after the `since` it receives (a generation it does not know, one from before it restarted, or one
older than the `removed` names it keeps) must answer every session with `full: true`, or send no
`generation` at all. Otherwise the page keeps rows that no longer exist. The background-list server
does this, and also seeds its generation from its start time (milliseconds), so that a listing after a
restart is never numbered below one sent before it. An answer whose generation is lower than the
`since` is applied as a full listing whatever it says.

An answer to `since` always carries `mesh`, possibly empty: an answer without a `mesh` array is not
merged, it replaces the page's listing as it is (and its `removed` is then not applied).

An answer to `since` carries only the changed rows. The page merges them by `id` into its last
listing, drops the names in `removed`, puts new sessions first, and sorts by `rank` (sessions never
moved first, newest on top) when the rows carry `rank`. `external` replaces the previous list when it is
present. A changed row without a string `id` cannot be merged: the page drops it and logs it to the
browser console (`console.debug`). For a mesh row, `id` is its name, so `removed` (names) matches `id`.

### Response, per row (`mesh[]`)

| Field | Type | Client use |
|---|---|---|
| `ready` | boolean | `false`: the row shows "loading" and is not authority. Absent: ready. |
| `state` | `"loading"`, `"ready"`, `"slow"`, `"error"` | Optional (not sent by the background-list server). Takes precedence over `ready`. `slow` and `error` show a retry button on the row; once the row is ready again, the focus moves from that button to the row. That button refreshes at once, with the row's session in `focus`. `"unreachable"` is the page's own state for rows it keeps while the PTY host is silent: a server never sends it, and the page ignores it if one does. |
| `priority` | integer or class | Not read by the client. |
| `agent.provisional` | `true` | Not read separately: the row's `ready` and the listing's `management.state` decide. |

## Status line

A line of fixed height above the list (`#sessions-status`). Only its message is a polite live region,
and the message changes only when the state does: it holds no clock time. The time of the next
attempt, the age of the list and the elapsed seconds are shown beside it and are not announced. In
order of precedence:

1. the browser is offline;
2. the server refused the list (an HTTP status below 500, after a first success), with the next attempt;
3. a request is pending after the server went away (network error or 502, 503, 504), or after it
   closed the terminals with code 1012: "the server restarted";
4. no answer within 180 s: "the server is slow, not gone", with the next attempt;
5. the server is unreachable (network error or 5xx), with the next attempt;
6. the page could not apply the last answer (an error in the page);
7. the first request is pending: "loading", with the number of sessions known on this device;
8. the PTY host is silent (as the page judges it, above), then restarted;
9. the server answered but lists nothing yet (empty and incomplete): "loading", as in 7;
10. `ready < total`: "describing the sessions", with the phase when the server names one. The
    "N / M ready" count is beside it and not announced, so a count that changes at every answer is
    not read out each time;
11. a request has been pending for 8 s: "the server is slow to answer", with the time of the list shown;
12. otherwise the line is empty.

Every line about a failure offers "Retry now".

## Tests

- `tests/sessions-progress.test.ts`: the poller's cadence, sharing, backoff and outcomes (timeout,
  page error) on a fake clock; the contract adapter; the status line; answers shaped like the
  background-list server's (a refresh without `since`, an empty pending answer, no `phase` or `state`,
  a silent host that keeps its rows).
- `tests/sessions-progress-parts.test.ts`: known sessions (with hostile stored values and the
  sign-out time), the `focus` order, host silence and its two-answer rule, the open replay cutoff,
  page signals, the window.
- `tests/inventory-pipeline.test.ts`: the inventory seam of `static/app.js` without a browser. An
  observed listing retires the pane targets of a replaced session; a failure, an invalid listing or a
  refusal applies nothing; a refused listing goes to the login page, but not after disposal.
- `tests/pane-menu-unbound-browser.test.ts`: a pane menu opened before a target exists runs nothing
  and binds on the next refresh.
- `tests/sessions-progress-browser.test.ts`: a real server and PTY host. It covers a server restart, a
  slow listing (terminals attach and rows appear first; a provisional row cannot be renamed), the
  focus after a row's retry button, and 300 synthetic rows (bounded DOM, no long task).
- `tests/sessions-window-browser.test.ts`: 300 synthetic rows. Focus survives scrolling, Tab reaches
  every row, an inline rename and a drag keep their row, the keyed morph never moves a focused or held
  node, and signing out removes the stored sessions.
