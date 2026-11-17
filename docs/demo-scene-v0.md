# Demo format `mesh-scene-v0`: a static scene

An agent started by the mesh can show you a demo next to its session: a small scene described as
JSON, which the mesh renders itself. The agent supplies no HTML, CSS or script, so a demo runs no
code of the agent's. This page describes the first format, `mesh-scene-v0`, a static layout of
text and blocks; the only interaction is expanding or collapsing a block. For a walkthrough with
states and choices, see [`mesh-scene-v1`](demo-scene-v1.md). How demos appear in the interface is
in [features.md](features.md#whiteboard-and-demos).

## Create, open, revise

The agent uses the tools of the `mesh-board` MCP server, which the mesh adds to Claude Code, Codex
and Pi when it starts them. `demo_create` takes the scene as its `scene` argument:

```json
{
  "scene": {
    "format": "mesh-scene-v0",
    "version": 0,
    "title": "Path of a request",
    "theme": "dark",
    "nodes": [
      {"type": "heading", "text": "session-mesh"},
      {"type": "row", "children": [
        {"type": "card", "children": [{"type": "text", "text": "Local agent"}]},
        {"type": "card", "children": [{"type": "text", "text": "Web server"}]}
      ]},
      {"type": "badge", "text": "Static diagram"}
    ]
  }
}
```

A successful creation returns revision `1`. `demo_open` with `{}` then opens the demo beside the
session, in the pages that already show that session.

To change the scene, the agent calls `demo_revisions` with `{}` to learn the current revision, then
`demo_update` with a complete scene whose `version` equals that revision (for example `1`). Each
update creates a new revision; old revisions never change. An update based on an old revision is
refused with a conflict and overwrites nothing. A demo already open stays on its revision until
the new one is accepted.

A session can also hold several named demos (up to 8), each with its own history.
`demo_create_named` creates one and returns an opaque `demo_id`; the title is only display text,
and several demos may share it. `demo_list` lists them, and `demo_read_named`,
`demo_update_named`, `demo_revisions_named` and `demo_open_named` take the identifier.
`demo_restore_named` takes `{demo_id, version, expected_version}`: if `expected_version` is still
the latest revision, the content of `version` is copied into a **new** revision
`expected_version + 1`. A stale `expected_version` is refused with 409, a missing demo or revision
with 404 and a full history with 507; none of these refusals writes anything.

## Nodes

A scene has a `title`, a `theme` (`dark` or `light`), a `version` and its `nodes`, all required.
The node types are:

| Type | Fields | Rendering |
|---|---|---|
| `heading`, `text`, `badge`, `shape` | `text` (up to 2000 characters) | text in the corresponding style |
| `divider` | none | a separator |
| `card`, `row`, `column` | `children` (up to 30) | a box, a horizontal or a vertical group |
| `disclosure` | `summary` (1 to 120 characters), `children` (up to 30) | a collapsible block, closed at first |
| `checklist` | `items` (1 to 20 texts of up to 120 characters) | tick boxes; ticks stay in the current view |
| `progress` | `label`, `value` (integer 0 to 100) | an accessible progress bar |
| `metric` | `label`, `value` (texts of 1 to 120 characters) | a figure with its label |
| `status` | `label`, `state` (`info`, `success`, `warning` or `danger`) | a status line |

For example:

```json
{"type":"disclosure","summary":"Acceptance criteria","children":[{"type":"text","text":"The prototype must stay readable on a phone."}]}
```

```json
{"type":"progress","label":"Scenarios covered","value":42}
```

```json
{"type":"metric","label":"Active sessions","value":"3"}
```

```json
{"type":"status","label":"Whiteboard synchronised: ready to test","state":"warning"}
```

The mesh chooses every style, colour, width and accessibility attribute; a `metric` shows the
agent's text and reads no figure from the mesh. Any other field or type is refused. Text that
looks like HTML or a URL is shown as plain text. A scene is limited to 64 KiB, 100 nodes and a
depth of 6.

## Isolation and storage

The demo pane is an opaque-origin frame with no sandbox permission and a restrictive Content
Security Policy. Expanding a block changes only that view, not the stored revision. This describes
a format that contains no code; it says nothing about what arbitrary JavaScript could do.

The tools act only on the session that calls them, through its session token: they take no
session name, path or URL, and neither the login cookie nor the master token can call them. Demos
are stored on the machine, in clear, in a private file, and survive restarts and the end of the
session. Storage is bounded: 64 revisions per session, 100 sessions and 8 MiB in total. When a
limit is reached, the write fails rather than delete an old revision.

## Deleting stored demos

The demos of sessions that have ended stay stored until you delete them, from the checkout:

```sh
python3 scripts/demo-scene-maintain.py list
python3 scripts/demo-scene-maintain.py delete --name NAME --created TIMESTAMP \
  --expected-current VERSION --confirm-delete
```

`list` shows only the session identities and revision numbers. `delete` removes exactly one
session's demos; for named demos it also needs `--expected-catalog` with the value `list` printed.
It refuses a session it sees running, an unreachable PTY host or a revision that changed since
`list`. It cannot see a session that starts during the command: stop the session first and do not
resume it meanwhile. The deletion cannot be undone. The command is not available through the API
or the MCP server, but it is not a barrier against an agent that runs a shell as your user and can
read the store directly.
