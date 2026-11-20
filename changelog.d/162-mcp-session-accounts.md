---
kind: added
---
- **An agent can tell which account alias its session runs under.** The `mesh-board` MCP server
  has a read-only `session_accounts` tool: the alias of the calling session (or `default`), the
  aliases declared on the runner with the agents each serves, and `switch_qualified`, false while
  Mesh cannot move the session to another account. It returns ids and labels only, never a
  folder, and takes no argument: the session and its agent kind come from the session token and
  the launch. A refused session request now gives
  the agent the server's reason instead of a bare HTTP status, so it can tell the owner why. See
  [Ask for sessions](docs/agent-guide.md#ask-for-sessions).
