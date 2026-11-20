---
kind: added
---
- **Claude and Vibe sessions start with a reminder of their tracked tasks.** At the start or resume
  of a session, a read-only hook adds one sentence with the ids of the tasks linked to the session
  or its folder and the counts of its questions, never their text; it stops after 1.5 s and stays
  silent on any failure. `MESH_PROJECT_HOOKS=0` turns it off. Every hook Mesh installs now comes
  from one model: see [Agent hooks](docs/agent-hooks.md).
