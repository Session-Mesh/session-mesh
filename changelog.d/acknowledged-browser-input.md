---
kind: added
---
- **Keep browser terminal input until the PTY host acknowledges it.** A negotiated terminal
  attachment retains bounded input through uncertain delivery and asks for explicit review
  before retrying; a switch-input fence can be acquired while these attachments remain open.
  This protects transport bytes, not native agent editor or queued work.
