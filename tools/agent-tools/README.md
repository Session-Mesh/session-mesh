# agent-tools

Small deterministic tools for the people and the coding agents who work on this repository: maintainers,
contributors and their agents. A command whose output is the same every time replaces repeated reading and
judgement, so work goes faster, costs fewer tokens and has fewer mistakes.

## Rules

- Language: bash, `gh`, `jq`, `sed`, `awk`. No Python. A tool that outgrows bash is rewritten in OCaml or TypeScript.
- **Read-only by default.** A tool that writes (merge, post a comment) has a name ending in `-do` and also needs
  `--yes`. Without `--yes` it prints what it would do.
- A tool never prints a secret or a token (it prints only the type and the line) and never reads credentials
  or any agent's configuration folder.
- No path of one person's machine inside a tool: locations come from the environment (see each tool's header).
- Exit codes: 0 = OK or GO, 1 = NO-GO or finding, 2 = usage or environment error.
- Every tool has a test, `tests/<tool>.test.sh`, that runs it against a fake `gh` (a stub placed first on `PATH`)
  with files from `fixtures/<tool>/` and compares with an expected output. `./selftest-all.sh` runs them all.
- A tool is trusted once its test passes, `shellcheck` is silent (when installed) and a person other than its author
  has read it.

## Private words

`merge-gate.sh` and `comment-do.sh` refuse text that contains a word from a private list. The list is **not in this
repository**: put one word per line, case-insensitive, in the file named by `AGENT_TOOLS_DENY_FILE` (default
`${XDG_CONFIG_HOME:-$HOME/.config}/agent-tools/deny-words.txt`). `deny-words.example.txt` shows the format. Without
the file the generic checks still run (token-like strings, home-directory paths, attribution footers) and the tool
says that the private list is missing.

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `pr-status.sh` | open PRs: head, merge state, checks that are not green | no |
| `ci-failures.sh <pr>` | failing jobs of a run of the PR head: fixed-pattern log lines (✖, " FAILED ", AssertionError, TypeError, ##[error], lines starting with `not ok`) | no |
| `merge-gate.sh <pr> <head8>` | GO / NO-GO checklist before a merge (checks, run of the base head, required checks, leaks, Python, .github, semver, changelog) | no |
| `merge-do.sh <pr> <head8> --yes` | merge (rebase) after a GO, pinned to the head commit read before the gate | yes |
| `comment-do.sh <pr\|issue> <number> <file> --yes` | post a comment after the leak checks | yes |

Environment: `REPO` (default `Session-Mesh/session-mesh`), `AGENT_TOOLS_DENY_FILE`, `REQUIRED_CHECKS`
(one check name per line; by default the merge gate requires cla, ruff and pytest (without browser),
frontend and Node tests, the OCaml gate, the native PTY host, the leak check and CodeRabbit).

## Use

```
tools/agent-tools/pr-status.sh
tools/agent-tools/ci-failures.sh 185
tools/agent-tools/merge-gate.sh 185 f9c45553
tools/agent-tools/selftest-all.sh
```

Planned: `worktrees-report.sh`, `live-state.sh`, `disk-report.sh` (read-only reports for an operator's machine).
