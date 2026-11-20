---
kind: added
---
- **An agent can ask to continue its conversation under another account.** When the owner asks
  in the conversation (for example "switch to the travel account"), a Claude or Codex agent calls
  the new `session_account_switch_request` tool of the `mesh-board` MCP server with the account id
  or label. The Mesh server matches the name for the session's own agent kind (the exact id, else
  one label ignoring case, never a prefix) and refuses an unknown, ambiguous or unusable account
  with a code and the list of accounts. Nothing happens until the owner approves it in one click;
  the dialog says that the whole conversation is copied to the other account and sent to its
  provider. Mesh then stops the session, copies the conversation with
  `mesh-platform accounts carry` and resumes it in a new session under that account; when the copy
  fails, the conversation resumes under its own account and the request says why.
  `switch_qualified` stays false. See [Ask for sessions](docs/agent-guide.md#ask-for-sessions).
