---
kind: fixed
---
- **Concurrent first uses of the backend profile store no longer fail at random.** When several
  `mesh-profile` processes opened a new store at once, about one round of eight in a hundred
  answered `backend-store-unavailable`: the switch to the WAL journal was refused at once while
  another process held the write lock. It is now retried within the store's 5 s busy budget, and
  the retried statement no longer keeps the connection open after it closes.
