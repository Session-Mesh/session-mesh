# The session list: `GET /api/sessions`

`GET /api/sessions` answers from a session list the web server keeps in memory. One background round at
a time reads the PTY host's list, describes the sessions and writes the restart snapshot; a request never
runs a listing of its own. The answer therefore comes in tens of milliseconds whatever the number of
sessions or polling pages, and a change (a new session, a rename, an agent that finished its turn) is
listed by the next round. This page is the contract for a client of that route.

## Rounds

A round starts when a request asks for one, or 10 seconds after the previous round; two rounds never
run at once, so the requests that arrive during a round share the next one. A round:

1. reads the PTY host's `list`;
2. on the first round after the web server starts, publishes a **skeleton**: one row per session the
   host lists, built from the host's list, the organisation (`mesh.json`) and the restart snapshot
   only, without reading `/proc` or any transcript;
3. describes every session (agent, conversation, state, last message) and publishes the rows;
4. records the restart snapshot. The snapshot is never written from a skeleton, and a session the host
   lists but the round did not describe keeps its previous snapshot entry: it is never offered for
   restore while it runs.

A host that does not answer `list` leaves the list and the snapshot as they were.

## Request

| Parameter | Meaning |
|---|---|
| `since` | A `generation` from an earlier answer: the answer then holds only what changed after it (below). Decimal, at most 16 digits; any other value, or a generation this server does not know, gives a full answer, never an error. |
| `focus` | Up to 64 session names, comma-separated, most wanted first (the panes on screen, pinned conversations, visible rows). Names that are not session names, repeats, names the host does not list, and everything after the 64th are dropped; a value longer than 4096 bytes is ignored. The accepted names are echoed in the answer's `focus`. The current round describes every session at once, so `focus` does not change its order yet. |

A request **with** `since` answers at once. A request **without** `since` (a page load, or a client
that expects a session it just created to be listed) waits for the round it asked for, at most
`MESH_SESSIONS_WAIT` seconds (default 2), and not at all before the first listing is complete or while
the host is silent. The first request after a start waits at most 0.25 s for the skeleton.

## Answer

The fields of the earlier answer are kept (`mesh`, `external`, `folders`, `management`, `restorable`,
`portfolio`, `update`, `sessionRequests`, `agentMailConsent`, `client_version`, and the others). These
are added:

| Field | Type | Meaning |
|---|---|---|
| `generation` | integer | Grows by one each time a row's content changes, a session ends, or `external` changes. It starts from the server's start time in milliseconds, so it never goes back when the web server restarts. Send it back as `since`. |
| `full` | boolean | `true`: `mesh` holds every session. `false`: the answer to `since` holds only the changed rows. |
| `removed` | names | Only when `full` is `false`: sessions that ended after `since`. Kept 10 minutes; an older `since` gets a full answer. |
| `complete` | boolean | `false` while rows are not described yet (`ready: false`), or before the first listing. A client may poll sooner then. |
| `counts` | `{total, ready}` | Sessions listed, and those described. |
| `host` | `"ok"`, `"silent"`, `"restarted"` | `"silent"`: the PTY host did not answer the last `list` (or has not for 0.25 s); the rows are the last ones known. `"restarted"`: the host's identity changed since the previous round. |
| `focus` | names | Only when the request had a `focus`: the names accepted. |

In an answer to `since`, `external` (terminals outside the mesh) is present only when it changed after
`since`; a full answer always has it.

## Rows

Every row of `mesh` has `ready`:

- `ready: true`: the row is a full description, as before.
- `ready: false`: a skeleton row. It has `id`, `name`, `kind`, `created`, `pid`, `cwd` (where the
  session started), `cmd` (the command the snapshot recorded, or empty), `attached`, `activity`,
  `known_agent`, `notice`, `label`, `folder` and `rank`. Its `agent`, when the snapshot knows the
  session, is `{type, session_id, provisional: true}`: the agent and conversation of the last
  recorded round, never its launch arguments. While any row is a skeleton row, `management.state` is
  `"pending"`: the rows are not yet authority for actions that act on an observed identity.

A row's `agent.argv` is unchanged in this version.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `MESH_SESSIONS_WAIT` | `2` | Seconds a request without `since` waits for the round it asked for. `0`: every request answers from the list as it is. When it is set, the wait also holds before the first listing and while the host is silent: the skeleton is not answered early (tests that read a complete listing right after a change set it). |
