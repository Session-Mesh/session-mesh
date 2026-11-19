# The session list: `GET /api/sessions`

`GET /api/sessions` answers from a session list the web server keeps in memory. One background round at
a time reads the PTY host's list, describes the sessions and writes the restart snapshot; a request never
runs a listing of its own. The answer therefore comes in tens of milliseconds whatever the number of
sessions or polling pages, and a change (a new session, a rename, an agent that finished its turn) is
listed by the next round. This page is the contract for a client of that route.

## Rounds

A round starts when a request asks for one, or 10 seconds after the previous round; two rounds never
run at once, so the requests that arrive during a round share the next one. A round:

1. reads the PTY host's `list` and publishes it at once (below);
2. describes every session (agent, conversation, state, last message) and publishes the rows;
3. records the restart snapshot. The snapshot is never written from a row that is not described, and a
   session the host lists but the round did not describe keeps its previous snapshot entry: it is
   never offered for restore while it runs. A description made from an older host list than the one
   already recorded is not written over it.

A request also asks for a read of the host's `list` apart from the rounds; requests that arrive
while one runs share the next. Each read of the host's list, by a round or for a request, is published
at once: a session it newly lists gets a row with `ready: false`, built from the host's list, the
organisation (`mesh.json`) and the restart snapshot only, without reading `/proc` or any transcript, and
the sessions it no longer lists are removed. A round then describes the new rows. After the web server
starts, every row is such a row until the first round's description: the **skeleton**.

A host that does not answer `list` leaves the list and the snapshot as they were.

The fields read beside the list (`update`, `sessionRequests`, `agentMailConsent`) are read beside each
round, each on its own: one that fails keeps its last value and stops neither the list nor the snapshot.

## Request

| Parameter | Meaning |
|---|---|
| `since` | A `generation` from an earlier answer: the answer then holds only what changed after it (below). Decimal, at most 16 digits; any other value, or a generation this server does not know, gives a full answer, never an error. |
| `focus` | Up to 64 session names, comma-separated, most wanted first (the panes on screen, pinned conversations, visible rows). Names that are not session names, repeats, names the host does not list, and everything after the 64th are dropped; a value longer than 4096 bytes is ignored. The accepted names are echoed in the answer's `focus`. The current round describes every session at once, so `focus` does not change its order yet. |

A request **with** `since` answers at once. A request **without** `since` (a page load, or a client
that expects a session it just created to be listed) waits for the round it asked for, at most
`MESH_SESSIONS_WAIT` seconds (default 2). Before the first round's description it waits only for the
skeleton, and it stops waiting once the host is silent. A session the host lists before the request
arrives is in its answer, with `ready: false` when no round has described it yet, however long rounds
last: the read of the host's list a request asks for takes milliseconds.

## Answer

Once a round has described the sessions, the fields of the earlier answer are kept (`mesh`, `external`,
`folders`, `management`, `restorable`, `portfolio`, `opens`, `signals`, `update`, `sessionRequests`,
`agentMailConsent`, `client_version`, and the others). Two cases have fewer:

- The skeleton has `mesh`, `external` (empty), `folders`, `home`, `restorable` (empty), `management`
  (`{"state": "pending"}`), `ptyhost` and `opens`; it has no `portfolio`, `signals`, `moved` or
  `hook_shadow`.
- An answer before the host has listed anything (a silent or absent host after a start) has only
  `mesh` (empty), `external`, `folders`, `management` and the fields every answer has.

Every answer has `now` (the time of the answer, in seconds), `update`, `sessionRequests`,
`agentMailConsent`, `client_version`, `restore_guard` and the fields below. These are added:

| Field | Type | Meaning |
|---|---|---|
| `generation` | integer | Grows by one each time a row's content changes, a session ends, or `external` changes. It starts from the server's start time in milliseconds, so it never goes back when the web server restarts. Send it back as `since`. It does not change when only the other fields change (`folders`, `management`, `restorable`, `portfolio`, `opens`, `signals`, the fields read beside the list): those are in every answer, a delta included, so a client must read every answer, also one whose `generation` did not change. |
| `full` | boolean | `true`: `mesh` holds every session. `false`: the answer to `since` holds only the changed rows. |
| `removed` | names | Only when `full` is `false`: sessions that ended after `since`. Kept 10 minutes; an older `since` gets a full answer. |
| `complete` | boolean | `false` while rows are not described yet (`ready: false`), or before the first listing. A client may poll sooner then. |
| `counts` | `{total, ready}` | Sessions listed, and those described. |
| `host` | `"ok"`, `"silent"`, `"restarted"` | `"silent"`: the PTY host did not answer the last `list` (or has not for 1 s); the rows are the last ones known. `"restarted"`: the host's identity changed since the previous round. |
| `focus` | names | Only when the request had a `focus`: the names accepted. |

In an answer to `since`, `external` (terminals outside the mesh) is present only when it changed after
`since`; a full answer always has it.

## Rows

Every row of `mesh` has `ready`:

- `ready: true`: the row is a full description, as before.
- `ready: false`: a row not described yet. It has `id`, `name`, `kind`, `created`, `pid`, `cwd` (where the
  session started), `cmd` (the command the snapshot recorded, or empty), `attached`, `activity`,
  `known_agent`, `notice`, `label`, `folder` and `rank`. Its `agent`, when the snapshot knows the
  session, is `{type, session_id, provisional: true}`: the agent and conversation of the last
  recorded round, never its launch arguments. Until the first round's description, `management.state`
  is `"pending"`: the rows are not yet authority for actions that act on an observed identity.

A row's `agent.argv` is unchanged in this version.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `MESH_SESSIONS_WAIT` | `2` | Seconds a request without `since` waits for the round it asked for. `0`: every request answers from the list as it is. |
| `MESH_TEST_SESSIONS_COMPLETE` | unset | Tests only, never in production: `1` makes a request without `since` wait for the whole round it asked for (at most `MESH_SESSIONS_WAIT`), also before the first listing and while the host is silent, for tests that read a complete listing right after a change. |
