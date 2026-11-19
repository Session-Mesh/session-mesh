# CLA signatories

Each line of the table below records one contributor's acceptance of the
[Contributor License Agreement](CLA.md). The contributor adds it themselves, in a commit they
author with the address the line gives; the line and that commit, kept in the repository history,
are the record. Maintainers do not sign. The procedure is in
[CONTRIBUTING.md](CONTRIBUTING.md#contributor-license-agreement).

The CI check `cla` reads this table as a pull request would leave it on `main`. It refuses a line
that the pull request adds without a commit authored with the line's address, and a line that it
removes or changes without a commit by its holder or by a maintainer. A line counts only as a table
row of the form below, outside code blocks and HTML comments, with an address in printable ASCII, a
published version and a real date. Add one line per address, in alphabetical order of public name,
in this form:

```text
| Your public name | ID+login@users.noreply.github.com | 1.0 | YYYY-MM-DD |
```

- **Public name**: the name you want shown; it is public and permanent.
- **Commit e-mail**: the author address of your commits, exactly as Git records it. GitHub's
  `ID+login@users.noreply.github.com` address is recommended, so that no personal address is
  published. Add one line for each address you commit with.
- **CLA version**: the version you accept, `1.0` today.
- **Date**: the day you add the line.

| Public name | Commit e-mail | CLA version | Date |
|---|---|---|---|
| Pierrick Couderc | pierrick@thrim.me | 1.0 | 2026-11-19 |
