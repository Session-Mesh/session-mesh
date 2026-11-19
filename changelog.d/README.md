# Changelog fragments

Each pull request adds **one file here** instead of editing `CHANGELOG.md`. Two pull requests then
never touch the same lines, and the entries are assembled into `CHANGELOG.md` when a release is
cut. The whole process is in [docs/changelog-fragments.md](../docs/changelog-fragments.md).

## The file

Name: `<pull request number>-<slug>.md`, for example `412-idle-codex-resume.md`. Before the pull
request has a number, `<slug>.md` is accepted; rename it once the number exists. The slug is
a lowercase letter, then lowercase letters, digits and hyphens.

Content: an optional front matter with one key, `kind`, then exactly one `CHANGELOG.md` bullet:

```markdown
---
kind: fixed
---
- **An idle Codex keeps its conversation after a PTY host restart.** The id is now read from the
  launch arguments of the running Codex process. See
  [Restoring sessions](docs/operations.md#restoring-sessions-after-a-pty-host-restart).
```

- `kind` is one of `security`, `added`, `changed`, `fixed`, `docs`, `internal`; without a front
  matter it is `changed`. It orders the entries (in that order, then by pull request number); it
  is not printed.
- The bullet starts with `- **` and a bold lead, the sentence a reader scans; continuation lines
  are indented by two spaces. One paragraph: no blank line, no heading, no second bullet.
- Lines are at most 100 columns; a Markdown link target does not count. Links are written as from
  the repository root, as in `CHANGELOG.md`.
- UTF-8 with LF line endings, no tab, no trailing space, no control, bidirectional or zero-width
  character, at most 8 KiB.

Check a fragment with:

```sh
node --experimental-strip-types tools/changelog/changelog.ts check
```

A change no user sees (tests, CI, internal documentation) needs no fragment: the pull request
description then holds a line `Changelog: none: <reason>`.
