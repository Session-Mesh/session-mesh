---
kind: added
---
- **"What's new" in the update banner shows the release notes in the page.** The notes of the
  announced release are rendered like a Markdown document (tables, code, links, images). They come
  from the releases list the PTY host already fetches, so showing them makes no request. Their
  images are fetched by the web server from GitHub's hosts only, never by the browser. See
  [Update notice](docs/operations.md#update-notice).
