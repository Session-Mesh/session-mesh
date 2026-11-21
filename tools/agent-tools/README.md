# agent-tools

Small deterministic tools for the people and the coding agents who work on this repository: maintainers,
contributors and their agents. A command whose output is the same every time replaces repeated reading and
judgement, so work goes faster, costs fewer tokens and has fewer mistakes.

## Rules

- Language: bash, `gh`, `jq`, `sed`, `awk`. No Python. A tool that outgrows bash is rewritten in OCaml or TypeScript.
- **Read-only by default.** A tool that writes (merge, post a comment) has a name ending in `-do` and also needs
  `--yes`. Without `--yes` it prints what it would do.
- A tool never prints a secret or a token (only the type and the line, and every displayed line has token
  shapes masked with `[token]`); it never reads credentials or any agent's configuration folder.
- No path of one person's machine inside a tool: locations come from the environment (see each tool's header).
- Exit codes: 0 = OK or GO, 1 = NO-GO or finding, 2 = usage or environment error (`pr-status.sh` never exits 1:
  it lists, it does not judge). `gh pr list` is given `--limit 200`.
- Every tool has a test, `tests/<tool>.test.sh`, that runs it against a fake `gh` (a stub placed first on `PATH`
  with files from `fixtures/<tool>/`) and compares with an expected output. `./selftest-all.sh` runs them all.
- A tool is trusted once its test passes, `shellcheck` is silent (when installed) and a person other than its author
  has read it.

## Private words

`merge-gate.sh` and `comment-do.sh` refuse text that contains a word from a private list. The list is **not in this
repository**: put one word per line, case-insensitive, in the file named by `AGENT_TOOLS_DENY_FILE` (default
`${XDG_CONFIG_HOME:-$HOME/.config}/agent-tools/deny-words.txt`). `deny-words.example.txt` shows the format. Zero-width
characters are stripped before matching. Without the file the generic checks still run (token-like strings,
home-directory paths, attribution footers) and the tool says that the private list is missing.
Token-like strings: `ghp_`, `gho_`/`ghu_`/`ghs_`/`ghr_`, `github_pat_`, `sk-` (preceded by a non-alphanumeric
character), `xoxb-`/`xoxp-` (Slack), `AKIA` + 16 uppercase alphanumerics (AWS) and `-----BEGIN ... PRIVATE KEY-----`
blocks. Home-directory paths: `/home/`, `/Users/`, `/root/` (only `/home/user` and `/home/USER` are excused).

## Tools

| Tool | What it does | Writes? |
|---|---|---|
| `pr-status.sh` | open PRs (up to 200): head, merge state, checks that are not green | no |
| `ci-failures.sh <pr>` | failing jobs of the run of the PR head: fixed-pattern log lines (`^FAILED `, `^ERROR `, " FAILED ", ✖, AssertionError, TypeError, ##[error], `^not ok`), a run still in progress prints the job states, a green run prints one line | no |
| `merge-gate.sh <pr> <head8>` | GO / NO-GO checklist before a merge (checks, run of the base head, required checks, leaks, Python (renames included), .github/workflows, semver, changelog; UNSTABLE accepted when the informational macOS job is the single non-green one) | no |
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

## Known limits

- Long hexadecimal runs are shown in the WARN detail unmasked (an sha is not a secret); a token that shares the
  line is still masked.
- Token types not detected: `xoxa-`/`xoxs-`/`xoxr-` (Slack) and the AWS session keys starting with `ASIA`.
- `.github/scripts` and `CODEOWNERS` are only WARNs (only `.github/workflows/` can turn the gate KO).
- A `.py` file with the API status `copied`, and a `.pyi` file, are not counted as added Python.
- A newline inside a changelog filename could inject false OK/GO lines in the output (the verdict and the exit
  code stay computed from the real data; this is a display-only risk).
- The fake gh does not model "the head moves BETWEEN the gate and the merge"; it models a push before the gate
  and a merge-time refusal otherwise.
- Case-insensitive matching of non-ASCII private words needs a UTF-8 locale (the tools ask for `C.UTF-8`; where it
  does not exist the match is ASCII-only).
- Not detected: other invisible characters (U+200E, U+2062, U+FE0F, tag characters), look-alike letters (for
  example a Cyrillic letter in place of a Latin one), Markdown or HTML escapes that GitHub displays as the word
  (`\-`, `&#45;`, `<!-- -->`), a token split by a tab or a newline, base64-wrapped values, binary-diff content and
  a token inside an added file's name.
- A trailing space in a deny-list entry stops it matching; ESC and OSC sequences in a title or file name are
  printed raw in the KO lines and in the pr-status listing.
