---
kind: fixed
---
- **OpenCode 2 configuration probes use a private server.** Mesh reads the location-scoped
  configuration API instead of passing an unsupported flag to `debug config`, preserving disabled
  MCP servers without contacting the shared background service.
