# Deck MCP grouped tools

The `mesh-board` MCP server advertises `whiteboard`, `demo`, `mail`, `session`, and
`agent_guide_read`. Call a group with no arguments or with `action: "describe"` to see its
catalogue. The result contains a
`commands` array with the action names, descriptions, and input and output schemas where
declared. Clients can read the catalogue in the JSON text block or in structured content.

These examples show the `params` object for a `tools/call` request.

```json
{"name":"mail"}
```

```json
{"name":"mail","arguments":{"action":"describe"}}
```

```json
{"name":"mail","arguments":{"action":"inbox"}}
```

```json
{"name":"mail","arguments":{"action":"read","arguments":{"message_id":"example"}}}
```

The outer `arguments` belongs to MCP. The inner `arguments` contains the action's original
fields. For an action with no fields, omit the inner object or pass `{}`. A nonempty inner
object requires an explicit action.

## Update existing callers

The grouped names replace the former flat names. Change the tool selector and move any
old parameters under the group's inner `arguments`. The guide still uses
`agent_guide_read` with no arguments.

| Former tool | New group | Action |
|---|---|---|
| `whiteboard_get` | `whiteboard` | `get` |
| `whiteboard_replace` | `whiteboard` | `replace` |
| `whiteboard_open` | `whiteboard` | `open` |
| `whiteboard_refresh` | `whiteboard` | `refresh` |
| `whiteboard_revisions` | `whiteboard` | `revisions` |
| `whiteboard_revision` | `whiteboard` | `revision` |
| `whiteboard_revision_diff` | `whiteboard` | `revision_diff` |
| `whiteboard_latest_change` | `whiteboard` | `latest_change` |
| `whiteboard_restore` | `whiteboard` | `restore` |
| `demo_create` | `demo` | `create` |
| `demo_update` | `demo` | `update` |
| `demo_revisions` | `demo` | `revisions` |
| `demo_open` | `demo` | `open` |
| `demo_list` | `demo` | `list` |
| `demo_create_named` | `demo` | `create_named` |
| `demo_read_named` | `demo` | `read_named` |
| `demo_update_named` | `demo` | `update_named` |
| `demo_revisions_named` | `demo` | `revisions_named` |
| `demo_restore_named` | `demo` | `restore_named` |
| `demo_open_named` | `demo` | `open_named` |
| `agent_peers` | `mail` | `peers` |
| `agent_inbox` | `mail` | `inbox` |
| `agent_message_read` | `mail` | `read` |
| `agent_message_send` | `mail` | `send` |
| `agent_message_reply` | `mail` | `reply` |
| `agent_message_ack` | `mail` | `ack` |
| `session_create_request` | `session` | `create_request` |
| `session_restart_request` | `session` | `restart_request` |
| `session_action_status` | `session` | `action_status` |
| `session_accounts` | `session` | `accounts` |
| `session_account_switch_request` | `session` | `account_switch_request` |

## Update client permissions

Before upgrading, add group rules for any client allow, deny or ask rules that target the
former tool names. Keep the former rules as well for as long as an older bridge or a rollback
may be used: an older bridge does not understand a group name. Use the group name with
whatever prefix your client adds for `mesh-board`. A group rule applies to the whole group,
including `describe`; review the full action list before carrying an allow rule over.

For Vibe sessions started by Mesh, the injected `mesh-board` configuration retains old
`disabled_tools` entries and also denies their corresponding groups when an old selector is
present. A group selector alone does not deny the former flat tools in an older bridge. Keep
both forms in configuration throughout upgrades and rollbacks. Mesh leaves configuration files
on disk as written.

## Upgrade running sessions

A release upgrade keeps the running PTY host and existing agent sessions. Their wake notices,
tool catalogues and client permissions can still refer to the old tools. After updating
permissions, restart the PTY host and restore the affected sessions when you are ready to
switch to the new names. Follow the [snapshot and restore procedure](operations.md#restoring-sessions-after-a-pty-host-restart).
For a source install, first run `scripts/bootstrap.sh --install-only` with the switch used by
Mesh to rebuild the bridge and host.

Session Mesh still checks the caller's session. Reading mail text uses the existing consent
flow, and session creation, restart and account switch still require the owner's approval.
