---
kind: fixed
---
- **Two agents starting the project tracker at the same moment no longer break it.** The first
  `work_*` call creates the data repository; its `taxonomy.yaml` is now written whole before it
  appears, so another agent's call never reads it empty. A creation that fails, on a full disk
  for example, no longer leaves an empty `taxonomy.yaml` that made every later call fail with
  "taxonomy.yaml cannot be read".
