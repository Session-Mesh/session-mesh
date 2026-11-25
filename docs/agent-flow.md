# Agent flow

The owner can open **Agent flow** to inspect accepted message deposits and sessions created by an agent.
The sequence view places sessions in columns and orders events by time; the connections view
shows their relationships. Both views use the same filters and event details. The current-session
filter uses the selected session's name and incarnation; when no session is selected, choose
**All Mesh** to see events across the mesh.

Mesh records metadata after a message deposit is accepted or a requested session is created.
A message event confirms only that the deposit was accepted: it does not establish that the
owner granted consent, that the agent received the message content, or that the agent read it. The
record contains the event type, time and session identities, not the message body or credentials.
The local journal retains at most 1,024 events and indicates when older events were removed.
Recording is best-effort and is not atomic with the operation itself: if the journal is
unavailable, or a new session has already disappeared before its incarnation can be read, the
event can be missing. Events from before recording began are not reconstructed.

The journal is stored in the private Mesh configuration directory and is available to the owner
through the authenticated web interface. Removing the journal removes its history; it does not
change sessions or messages. These views do not currently display individual MCP calls. The
separate optional MCP call journal is described in [Operations](operations.md#mcp-call-tracing).
