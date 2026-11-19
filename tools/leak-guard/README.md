# leak-guard

Searches the tree, staged files, commits, commit messages and identities for leaks before they
reach the public repository. TypeScript run by Node's type stripping; no dependency.

```sh
node --experimental-strip-types tools/leak-guard/cli.ts <command>
```

| Command | Checks |
|---|---|
| `worktree` | tracked and untracked (not ignored) files: content and names |
| `staged` | added lines and new file names in the index |
| `commits <A..B>` | per commit: message, trailers, author, committer, added lines, new file names |
| `tree <dir>` | every file under a directory |
| `message <file>` | a commit message and its trailers |
| `pr-body <file>` | a pull request description: the content rules only (no session-trailer or identity rule) |
| `identity <name> <email>` | a commit identity |
| `hooks install\|status\|uninstall` | the Git hooks below |

Options: `--private <file>`, `--exceptions <file>`, `--no-secrets`, `--scope worktree|local`.
Exit status: 0 clean, 1 findings, 2 usage or tool error. The report gives `file:line`, gate, rule and
a bounded excerpt, after a count per rule.

## Rules

- **Generic** (`rules.public.json` and `rules.ts`, owner-neutral): secrets through `gitleaks`
  (a clear warning when it is not installed; `MESH_LEAK_GITLEAKS` overrides the binary), Tailscale
  keys (any `tskey-<kind>-` prefix and the older untyped form, in any case, masked in every report line; gitleaks 8.30 has no rule for them), e-mail
  addresses outside the allowed forms (GitHub noreply, example and reserved domains; `%40` counts
  as `@`), real home directories (`/home`, `/var/home`, `/Users`, `C:\Users`; templates such as
  `/home/USER` pass), Tailscale CGNAT IPv4 and ULA IPv6 addresses, precise `*.ts.net` names in any
  case, agent session trailers (they can leak a session id), identities outside `users.noreply.github.com` (the generic rules also apply to identity names).
  The session-trailer and identity rules apply in `commits`,
  `message`, `identity` and the hooks, which contributors may leave aside. The public CI runs
  `worktree` on the files, and `pr-body` on the pull request description.
  `pr-body` applies the content rules of a message (secrets, e-mail addresses, home paths, tailnet
  addresses and names, private list) and leaves out what only makes sense for a commit: the
  agent session trailer lines and identities. A
  description is never exempted (see below). It exits 1 on a finding, like the other commands; the
  `pr-description` workflow reports it as a warning for now and does not fail.
- **Private**: a JSON file kept outside the repository,
  `{"schema": 1, "forbidden": [{"id", "literal", "caseInsensitive"}]}`, given by `--private` or
  the `MESH_LEAK_PRIVATE_RULES` environment variable. Without it the tool says so and applies the
  generic rules. No file in the tree may quote its content, tests included.

`static/vendor/` is exempt from the e-mail and `*.ts.net` rules only, never from secrets.

The files of `email.registers` (`CLA-SIGNATORIES.md`, whose rows publish each signatory's commit
address on purpose) are exempt from the e-mail rule only, and only for the address cell of a row
`| name | address | version | YYYY-MM-DD |`; the rest of the file and every other rule still apply.

## Exceptions

`exceptions.json` holds reviewed entries `{path, rule, substring, reason}`; `substring` must equal
the exact value the rule matched (not merely appear in the excerpt). Only file content and file
names can be excepted, never a message or an identity: `path` must be a tree path (relative, no
empty, `.` or `..` segment, no `<` or `>`), so labels such as `<message>` are refused when the
file is loaded, and a secret gitleaks finds in a commit message carries no value an exception could
match. An entry that no longer matches fails `worktree` and `tree`; for a secret the report names
the rule and the reason, never the digest. Tailscale key and private-list findings cannot be excepted.

A gitleaks secret can be excepted only for one file and one exact value, for a value that is
public by nature (a key a third-party package ships in a generated file): `rule` is `secret` and
`substring` is `<gitleaks rule id>:sha256:<SHA-256 of the exact value, lowercase hex>`, so the file
never holds the value. Reports never print the value or its digest; the reviewer computes the
digest from the file. When gitleaks did not run, unused secret exceptions are not reported stale.
gitleaks runs without its own redaction so that the digest can be computed: its JSON report is written
to standard output (`--report-path -`) and read in memory, so the raw values never reach the disk, even
when the scan is interrupted; the tool prints `REDACTED` itself. A malformed report, gitleaks'
failure and an unexpected error are reported without any part of the report, of gitleaks' error
output or of the error message, since each can quote scanned content.

A private-list finding can only be authorized in the private list itself, so the tree never cites
it: an optional `"allow": [{"path", "rule", "value"}]` array beside `forbidden`, where `rule` is a
private rule id and `value` an exact text of that file containing the rule's literal. An entry lifts
only the hits that lie inside an occurrence of `value` in that file (content or file name, never a
message or an identity), in every command; one that lifts nothing fails `worktree` and `tree`, and
its value is never printed.

gitleaks always runs with its default rules: a `.gitleaks.toml`, the `GITLEAKS_CONFIG` variables
and `gitleaks:allow` comments are ignored (a `.gitleaks.toml` in the scanned tree gives a warning).
gitleaks applies a `.gitleaksignore` at the root of what it scans whatever its flags, so such a
file is itself a finding (`gitleaks-ignore-file`).

## Messages

`commits` and `message` check every line of the recorded message, comment lines and text below a
scissors line included. The `commit-msg` hook reads the message before git cleans it up and cannot
know the cleanup mode, so it checks comment lines too (`git commit -m` and `-F` keep them); it only
skips what follows git's own cut line when it is followed by git's two-line notice and then nothing or the diff (`diff --git`); git writes it in verbose
and scissors mode and always removes. With the editor, file names in git's status comments are
therefore checked; `git config commit.status false` drops that block from the template.

Known gap of the hook: a leak placed after a cut line, its two `#` notice lines and a line starting
with `diff --git` passes the hook, because the hook cannot tell it from git's own diff. `commits`
still catches it, since it reads the message as recorded.

Type checking: `tsc -p tsconfig.leak-guard.json` needs `@types/node`, which is not yet a
development dependency of the repository: install it locally to type-check the tool.

## Hooks

`hooks install` declares two hooks in Git configuration (worktree scope when
`extensions.worktreeConfig` is on), printing every key it writes:

- `hook.session-mesh-leaks-staged` on `pre-commit`: `staged`;
- `hook.session-mesh-leaks-msg` on `commit-msg`: the message, trailers, author and committer.

If your clone also has hooks of its own (in `.git/hooks/` or a `core.hooksPath` directory), Git
runs them and these configuration hooks for the same event, and either refusal blocks the commit.
`hooks install` writes no hook file and does not change `core.hooksPath`. Pass `--private <file>` (or set the variable) at install time so the
hooks apply the private list. Hooks are a convenience: run `commits` before merging.

**The hooks need Git 2.54 or later**, the first release that runs hooks declared in configuration
and has `git hook list`. An older git (Ubuntu 24.04 ships 2.43) stores the `hook.*` keys like any
unknown key and never runs them, so `hooks install` refuses there, says why and writes nothing,
and `hooks status` reports the hooks as not active for that reason. With such a git, run
`staged` or `commits <A..B>` by hand before pushing; the CI leak check does not depend on the
local git.

## Limits

- A value split across two lines, or across a line break inside a file name, is not seen: rules
  and private literals match within one line.
- Compressed or encoded content (gzip, zip, images with compressed text, base64, hex) is not
  decoded. Binary files are read as latin1 and as UTF-16 at both byte alignments; other encodings
  are not. Line numbers in a binary file are positions in that decoded text.
- `commits` reads commits, not annotated tags: a tag message or tagger identity is not checked.
- The hooks run on `git commit` only. `git merge`, `cherry-pick`, `rebase`, `am` and `revert` can
  create commits without `pre-commit` (and some without `commit-msg`); `commits <A..B>` covers them.
- A merge commit is checked against its first parent only.
- The exit status is 0 when gitleaks is missing or when no private list is given: the report then
  carries a warning, which callers must read. Without gitleaks secrets are not checked; without a
  private list only the generic rules apply.
- Generic variants not recognized: other spellings of an address (`[at]`, `(at)`), home roots other
  than those listed, and Tailscale names or addresses written in other notations.
