---
kind: added
---
- **An optional Whisper-compatible relay provides bounded transcription jobs.** Configure an
  endpoint to enable authenticated, session-bound uploads, cancellation and result settlement.
  Remote endpoints require HTTPS; loopback HTTP is supported. Worker failures disable dictation
  without stopping the web server, and an unset language enables automatic language detection.
  See [configuration](docs/operations.md#whisper-dictation).
