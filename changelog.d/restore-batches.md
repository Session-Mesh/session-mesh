---
kind: fixed
---
- **Restoring or ignoring more than 50 lost sessions works.** The restore bar sends the names in
  batches of at most 50, one after the other, instead of one request the server refused; a
  failed batch keeps the results of the earlier ones and leaves its sessions offered.
