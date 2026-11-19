<!--
This description becomes public and permanent. Write it for a reviewer who must decide whether
the change is right: what it does, why, and how they can check it.

Keep it about the change, not about you. Leave out:
- machine names, user names, home paths (/home/<you>/…), IP addresses, tailnet or internal host
  names, tokens, and e-mail addresses other than a GitHub noreply address;
- your employer, clients or private projects;
- how you work: your editor, agents, prompts, session logs, local scripts or setup.
Paths are relative to the repository. An environment is a generic platform ("Ubuntu 24.04,
Chromium 131"). Output is the few relevant lines, with personal paths replaced by `~`.

Decisions and their technical reasons are welcome, and most useful. Delete these comments and any
section that does not apply, except "How to check".
-->

## What

<!-- What this pull request changes, as a user or a caller sees it. One short paragraph. -->

Closes #

## Why

<!-- The problem it solves, or the issue it answers. If the cause was not obvious, say how it was
established: a reproduction, a failing test, a reading of the code at a given revision. -->

## How

<!-- The design choice, and the alternatives you set aside with the reason for each. Name trade-offs
and limits: what stays unsupported, what behaves differently. Point at the files a reviewer should
read first. -->

## How to check

<!-- Commands a reviewer can run from a clean clone, and what they should see. Name the tests you
added or changed, and the test that failed before this change. If something could not be tested,
say "not tested" and why; do not leave it out. -->

```sh
scripts/test-local.sh
```

## Checklist

- [ ] The complete local suite passes, or the description says what was not run and why.
- [ ] New behaviour has tests; a bug fix has a test that failed before the fix.
- [ ] No new Python: new code and tests are in OCaml or TypeScript ([CONTRIBUTING.md](https://github.com/Session-Mesh/session-mesh/blob/main/CONTRIBUTING.md#no-new-python)).
- [ ] User-visible changes are in [docs/features.md](https://github.com/Session-Mesh/session-mesh/blob/main/docs/features.md) or [docs/operations.md](https://github.com/Session-Mesh/session-mesh/blob/main/docs/operations.md), and new interface text is in both language catalogues.
- [ ] A trust-boundary change (authentication, `/view`, session tokens, the route table, sandboxes) is stated in "How", and [SECURITY.md](https://github.com/Session-Mesh/session-mesh/blob/main/SECURITY.md) is updated if its threat model changes.
- [ ] A user-visible change or a fix adds one changelog fragment, `changelog.d/<number>-<slug>.md` ([format](https://github.com/Session-Mesh/session-mesh/blob/main/changelog.d/README.md)), and does not edit `CHANGELOG.md`; otherwise this description has a line `Changelog: none: <reason>`.
- [ ] My line is in [CLA-SIGNATORIES.md](https://github.com/Session-Mesh/session-mesh/blob/main/CLA-SIGNATORIES.md), in a commit of my own (first contribution only).
- [ ] This description and my commits contain no personal or machine-specific details (see the comment at the top), and `node --experimental-strip-types tools/leak-guard/cli.ts worktree` is clean.
