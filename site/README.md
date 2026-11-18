# session-mesh showcase site

A static page that presents session-mesh through a simulation of its own interface: the sidebar of
sessions, pane tabs, a second column for pictures and documents, and the phone layout with its
"Sessions", "Panes" and "Actions" buttons. Navigating the page is using the interface.

It has no build step, no framework, no external request and no analytics. All URLs are relative,
so it works from `file://` and from any static host, at any sub-path.

## Preview

Open `site/index.html` in a browser, or serve the folder:

```sh
npx serve site
```

## Publishing

The site is published at <https://session-mesh.com/> by GitHub Pages. `.github/workflows/site.yml`
runs on each push to `main` that touches `site/`, `.github/scripts/site-stage.sh` or the workflow
itself, and on demand (Actions tab, "site", "Run workflow"). It runs the page checks, stages `site/`
without `tools/` and `README.md`, adds a `CNAME` file (`session-mesh.com`) and deploys the result.
It uses no secret and no password.

One-time setup by the repository owner:

1. Make the repository public (Pages needs that on the free plan), then in Settings, Pages, set the
   source to "GitHub Actions".
2. In the same page, set the custom domain `session-mesh.com`.
3. At the registrar, set the DNS records for the apex domain: `A` records `185.199.108.153`,
   `185.199.109.153`, `185.199.110.153`, `185.199.111.153`; `AAAA` records `2606:50c0:8000::153`,
   `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`; and a `www` `CNAME` to
   `session-mesh.github.io`.
4. Recommended: verify the domain for the organization (organization Settings, Pages), so that
   nobody else can claim it.
5. Once the certificate is issued, tick "Enforce HTTPS".

## Previews of pull requests

`.github/workflows/site-preview.yml` publishes each pull request to `main` that changes the site at
`https://session-mesh.github.io/site-staging/pr-<number>/`, in the repository
`Session-Mesh/site-staging` (GitHub Pages from its `main` branch). The link shows on the pull request
as the deployment of the `site-preview` environment. The preview carries a robots `noindex` tag; it
is removed when the pull request is closed or merged (by `.github/workflows/site-preview-cleanup.yml`,
which has no `paths` filter, so that a pull request that reverted its site changes is still
cleaned up), and a daily run removes any preview not published again for 14 days.
`.github/scripts/site-preview.sh` makes these changes. The jobs that hold the App token run that
script from a checkout of `main` (`base/`), never from the pull request's branch, and treat the
pull request's staged files as data. Before replacing a preview, `publish` checks with GitHub that the
pull request is still open and its head is the revision the run was triggered for (the one place the
token of the run is used, read-only, with `pull-requests: read`), so a run that finishes late neither
brings back a removed preview nor replaces a newer one. `build`, `publish` and the removal share the
concurrency group `site-preview-pr-<number>`.

`.github/scripts/site-stage.sh` stages by a positional whitelist (`.github/scripts/site-csp-check.mjs`, which
needs node and parses neither HTML nor SVG). The reference is always the checkout of `main`, never the
pull request's own files: the `build` job takes a read-only checkout of `main` in `base/` and stages
against it, and the token-bearing `publish` job runs the gate again, from `base/`, on the downloaded
artifact before the App token exists. It refuses to stage: an HTML page that does not start, byte for byte,
with the head of `main`'s `site/index.html` up to and including its Content-Security-Policy `<meta>` tag
(so the policy is the first thing a browser reads and governs the rest of the page; that head must be plain
ASCII); a symbolic link; a file whose extension is not in a short allow-list (so no `.htm`); a NUL byte
in a page; any file above `MAX_FILE_BYTES` (10 MiB), a staged tree above `MAX_TOTAL_BYTES` (100 MiB) or
more than `MAX_FILES` (5000) files and directories (GitHub Pages allows 1 GB per site and 100 MB per file; the
caps are deliberately far below, and are decided from `lstat` before any file is read, one refusal line each);
and any `.svg`, `.xml` or `.xhtml` file that is not byte-identical to the file at the same path
of `main`. Such a file can be opened by a browser as a document with no policy, and a blacklist of its
content cannot be made reliable (encodings, non-ASCII prefixes), so it is not scanned at all. Two
consequences to know: a pull request that changes or adds site artwork in SVG cannot preview that SVG
(the preview fails with one line naming the file; the artwork is checked after the merge), and a pull request
that changes the Content-Security-Policy of `site/index.html` is refused in its own preview and is
previewed only after it is merged. `site.yml`, which runs after a merge, uses its own checkout as the
reference, so it does not refuse these. What the gate guarantees: every staged HTML page carries the policy
of `main` before any other content, and no SVG, XML or XHTML file differs from `main`. What it does not: the
policy is only as strict as the one in `main`, and the preview host must serve the files with the types
their extension suggests.

**Trust model of the shared origin.** The policy allows `script-src 'self'`, and every preview is served
from the same origin, `https://session-mesh.github.io`: any `.js` file of a pull request runs there, next
to the other previews. This is by design, because a preview must run the page's scripts. It is acceptable
because only branches of this repository get a preview (maintainers; none for forks), the origin holds no
secret and sets no cookie, and nothing but previews is served from it. Do not put an application with a
session, a cookie or a secret on that origin.

The workflow writes the staging repository through a GitHub App installed on
`Session-Mesh/site-staging` only, with the Contents write permission. Its ID and private key are the
secrets `SITE_PREVIEW_APP_ID` and `SITE_PREVIEW_APP_PRIVATE_KEY` of the `site-preview` environment;
each run creates a token scoped to site-staging that lasts one hour. `pull_request` runs the
workflow of the pull request's branch, so the App's key reaches whoever can push a branch to this
repository; a pull request from a fork or from Dependabot gets no secret and no preview. The
`site-preview` environment has no protection rule and no deployment branch policy, by choice: the
trust model above is that anyone who can push a branch here is trusted with a key that can only write
site-staging, and a required reviewer would make every preview wait for a person. Restricting the
environment to the repository's branches with a deployment branch policy is recommended once the
secrets exist; check then that the policy accepts the ref of a `pull_request` run (the pull
request's merge ref), because the workflow itself would not change.
Until the two secrets are created, every run publishes nothing and says so.

Known limits of the previews, accepted for this first version:

- GitHub does not run `pull_request` workflows for a pull request that conflicts with `main`, so the
  preview of a pull request that closes in that state stays until the 14-day expiry.
- A cleanup that waits in the concurrency group can be replaced by a later pending run of the same
  group (GitHub keeps one pending run); the preview then also stays until expiry, and `publish` never
  publishes for a closed pull request.
- A close run that starts after the pull request was reopened and published again removes the new
  preview; the next push publishes it again.
- The gate compares bytes and does not review them: the page checks of `check-page.mjs` remain the
  review of the page's content, and the scripts of a previewed branch run as described in the trust
  model above.
- The scripts need `perl` and `node` (on the runners and on macOS) and bash 3.2 or newer; they use no
  GNU-only `sed` option.

## Files

| File | Role |
|---|---|
| `index.html` | All the content, as ordinary HTML. Without JavaScript it reads as one long page. |
| `site.css` | Styles. The colours and shell rules are copied from `static/style.css`. |
| `status-core.js` | Reads the feature status table and writes its summaries and gates; shared by the page and `tools/sync-status.mjs`. |
| `site-status.js` | Applies the status table to the page: chips, summaries, gated elements and session counts. |
| `site.js` | The shell: session selection, Live and History tabs, typed command line, the second column, filter, keyboard, dialogs, the "waiting for you" nudge, the mock in `collaborate`, the Linux and macOS tabs of `install` and the pre-launch note. |
| `.agents-strip` in `welcome` | The built-in agents, as a looping strip of chips, each with its mark and name, and a last "More to come" chip; still and wrapped when the reader asks for reduced motion. The marks are in `assets/agents/`: Simple Icons (CC0-1.0), the Copilot mark (MIT) and LobeHub Icons for Codex and Antigravity (MIT); see `assets/agents/NOTICE.txt`. The list is written by hand: to add an agent, add its item to both copies of the list and its mark to `assets/agents/`. |
| `hero-replay.js` | The illustration of the welcome section: a replay of one message between two agents, up to the consent request that the visitor answers. |
| `board-replay.js` | The whiteboard panel of `collaborate`: a mock Excalidraw board drawn by the reader, then edited by the session's agent. It replaces the first panel when a link with `data-variant-open="whiteboard"` is selected; a `<figure class="visual">` with `data-variant` is a second panel of its section. |
| `releases.json` | The releases listed in the History tab and their highlights, with the sources each highlight is checked against. |
| `tools/changelog-to-history.mjs` | Regenerates the History tab and the Releases section from `releases.json`, after checking its sources against `CHANGELOG.md` and the docs. |
| `tools/sync-status.mjs` | Writes the feature statuses, gates and session counts into the static HTML, for readers without JavaScript. |
| `tools/whiteboard-strokes.mjs` | Prints the two SVG groups of the whiteboard mock in `collaborate`, with hand-drawn strokes from a fixed seed. Paste its output into the `<svg class="board-canvas">` of `index.html` after changing the drawing. |
| `assets/Excalifont-Regular.woff2` | The hand-drawn font of Excalidraw, used by the whiteboard mock; copied unmodified from `static/vendor/fonts/`, under the SIL Open Font License 1.1 in `assets/OFL-1.1-Excalifont.txt`. |
| `tools/check-page.mjs` | Checks links, quotations and gates, and builds the launch preview (see below). |
| `assets/` | Screenshots, logo and favicon. The four screenshots (`desktop.png`, `consent-request.png`, `phone-sessions.png`, `phone-terminal.png`) were taken on 15 November 2026 on a throwaway instance started with `scripts/preprod.sh`, with two Claude Code sessions and one Pi session working on a sample project; they differ from `docs/images/`, which still shows sample shell sessions. Nothing was drawn on them or cut from them. The logo and favicon are copied from `static/`. |
| `assets/roster-pipeline.svg` | The diagram of the `roster.md` document in `structure`: the output of `static/vendor/mermaid.min.js` (dark theme, `htmlLabels: false`, rank spacing 26, node spacing 30) for `flowchart TD` with `intake([intake]) --> spec --> plan --> implement --> review --> qa[QA] --> ship([ship])`, with a fixed width and height on the root element. |

The page carries a Content Security Policy that allows only its own files: no inline script or style.

## Content and sessions

Each `<section class="sess">` in `index.html` is a session in the sidebar; its `id` is the session
name and the URL hash (`#security`). A section holds a command line (`.cmdline`), the text, and a
`<figure class="visual" data-for="…" data-title="…">` that the script moves into the second column. A section without one opens on the full width, and the controls of the second column are hidden while it is shown.

| Session | Agent | Second column |
|---|---|---|
| `welcome` | bash | the three screenshots; the first screen holds an HTML illustration of the session list instead |
| `see` | claude | the two phone screenshots |
| `collaborate` | codex | a mock of two agents exchanging a message, with the consent step |
| `structure` | claude | a `roster.md` document written for this page |
| `projects` | bash | none; gated on `projects` (see below) |
| `security` | bash | none: the section stands alone and links to `SECURITY.md` |
| `roadmap` | pi | `preview · next`: a Projects mock and a sidebar grouped by machine. The status table stays in the section, hidden: it still sets every status of the page |
| `install` | bash | none: a short section that announces the standalone package, without commands, until the installer is released |
| `history` | changelog | the list of releases, made from `releases.json` |

To add a session, add a sidebar entry (`<a class="item" href="#id" data-session="id">`), a section
with the same `id`, and the id to `ALL_SESSIONS` in `site.js` (and to `AGENT_SESSIONS` if it runs an agent).
A section renamed later keeps its old hash working through `ALIASES` in `site.js`: `#frame` opens
`#structure`. A link to an element inside a section (`#status`) opens that section at the element.

What the page says exists must come from the README, `docs/agents.md`, `docs/install.md`, `docs/features.md`, `docs/operations.md`,
`docs/projects.md`, `SECURITY.md` or `CHANGELOG.md`, and the install commands are copied from the
`docs/install.md` (Linux) and `docs/operations.md` (macOS). A text quoted from one of
them sits in `<blockquote class="quote" data-source="FILE">`, with `[…]` marking each cut. Planned
work is shown only with its status chip. Documents written for the page say so in their header.

Words used across the page: *session-mesh* for the product (never "the mesh"); *pane* for an area
that shows a terminal or a document, *column* for the layout division that holds panes.

## Feature statuses

One table sets the status of every feature the page names: `<ul id="status-table">` in the
`roadmap` section, one `<li data-feature="ID" data-status="STATUS" data-label="LABEL">` per
feature, with one sentence saying what the feature is for. The statuses and the legend:

| Status | Meaning |
|---|---|
| `available` | in the code you install today |
| `in progress` | code exists, not released |
| `planned` | not started yet |

`site.js` derives everything else from the table: the chips elsewhere (`data-status-of="ID"`, in
`structure`), the legend copied wherever chips are used (`data-legend-copy`), the "not in it yet"
sentence of the roadmap (`data-status-pending`) and any sidebar excerpt that lists statuses
(`data-status-summary`; none today). Changing one `data-status` changes all of them. For readers without
JavaScript, `node site/tools/sync-status.mjs` writes the same texts into the HTML;
`--check` fails when they are out of date.

### Gates: content that waits for a feature

An element with `data-requires="ID"` is shown only while feature `ID` is `available` in the
table; one with `data-unless="ID"` only until then. Both `site-status.js` and `sync-status.mjs`
set its `hidden` attribute, so the page without JavaScript follows the same rule, and the session
counts (`data-session-count`) leave out a hidden session. The gates in use today:

| Feature | Status | Waiting for it (`data-requires`) | Shown until it is available (`data-unless`) |
|---|---|---|---|
| `projects` | available | the Projects session and its sidebar entry, the hint in `see`, the "Next: projects" link of `structure`, the Projects highlight of the release | the "Next: security" link of `structure` |
| `agent-projects` | available | nothing yet | nothing yet |
| `binaries` | in progress | nothing yet; the chip in `install` follows its status | nothing yet |
| `macos-documents` | planned | the platform highlight of the release without the macOS limit | "Documents beside the terminals are Linux-only for now" in `see`, in the macOS row of the status table, in the platform list of `install` and in the platform highlight of the release |

`macos-documents` is a row of its own so that one edit removes the macOS limit everywhere if
documents beside the terminals turn out to work on a Mac: set it to `available`, run
`sync-status.mjs`, and correct `docs/operations.md`, which says they are Linux-only.

`node site/tools/check-page.mjs` checks that every `#` link names an element and every relative
file exists, that every quotation matches its source file, and that each gate follows the table.
It then builds a launch preview: a scratch copy where every gated feature that is `in progress`
is set to `available` (what the launch is expected to release; `planned` features stay as they
are) and `sync-status.mjs` has run, where the gated elements of those features must show and
their links resolve. `--keep DIR` keeps that copy, to open it in a browser before the launch. A
last pass opens every gate, `planned` features included, so the text that replaces a caveat is
checked before it ships.

## History: the releases

The History tab mirrors the app's History tab, which lists past conversations; here it lists the
releases, one item per tagged version, and a line at the top of the tab says so. Opening a release
(`#history/v0.1.0`) shows its highlights: a few user-facing lines, each one sentence, followed by a
link to the full `CHANGELOG.md` on GitHub. Individual changes are not listed on the page; the
changelog has them. The History tab has no filter.

The highlights are written for the page, not copied from the changelog, and live in
`releases.json`, newest release first:

```json
{
  "version": "v0.1.0",
  "title": "first public release",
  "changelog_heading": "Unreleased: first public release",
  "summary": "The first public release of session-mesh, an alpha.",
  "highlights": [
    {
      "text": "Documents beside the terminals: HTML, Markdown, PDF, images and source files, in a sandboxed viewer.",
      "sources": [
        { "file": "CHANGELOG.md", "lead": "Documents beside the terminals." },
        { "file": "docs/features.md", "heading": "Documents beside the terminals" }
      ]
    }
  ]
}
```

Each highlight names the sources it was checked against: a bullet of that release's section of
`CHANGELOG.md`, by its bold lead (`lead`), or a heading of a Markdown file of the repository
(`heading`). `text` is plain text; backquotes mark code. A highlight with `"requires": "ID"` or
`"unless": "ID"` is gated on a feature of the status table, like any other gated element.

Do not edit the History by hand. Run:

```sh
node site/tools/changelog-to-history.mjs          # rewrite index.html from releases.json
node site/tools/changelog-to-history.mjs --check  # fail if index.html is out of date
```

Both forms first check `releases.json` against the repository and stop if a release's
`changelog_heading` is not a `## ` heading of `CHANGELOG.md`, or if a source no longer exists.
The script rewrites what lies between the `history-sidebar`, `history-toc` and `history-entries`
marker comments in `index.html`, and the count of the History tab.

To add the next release: add an object at the top of `releases`, with `version` as tagged
(`v0.2.0`, which is also its URL, `#history/v0.2.0`), `changelog_heading` exactly as the
release's heading in `CHANGELOG.md`, and four to seven highlights a user notices, each checked
against the changelog and the docs and naming them as sources. Keep the older releases and their
versions unchanged, so their links keep working. Then run the script and `check-page.mjs`.

Without JavaScript the section reads as a "Releases" section at the end of the page.

## Before the first tag

The page carries no pre-launch marker and no date. The first release is listed as `v0.1.0` in
`releases.json`, the version it will be tagged as, so the page does not change when the tag is
made; `CHANGELOG.md` keeps the heading "Unreleased" until then.

## Launch checklist

1. For each feature of the status table that is released with the launch (for example `projects`):
   - set its `data-status` to `available`;
   - replace its one-sentence description with one checked against the feature's entry in
     `docs/features.md` and `CHANGELOG.md`, and do the same for its clause in the `structure`
     section if it has one;
   - then run `node site/tools/sync-status.mjs`. For `projects`, this also shows the Projects
     session, its sidebar entry, the hint in `see`, the "Next: projects" link of `structure` and
     the Projects highlight of the release; re-read the Projects section against `docs/projects.md`
     and replace its mock with a screenshot if one can be taken.
2. When the first release is tagged and its `CHANGELOG.md` heading renamed, set its `changelog_heading` in
   `releases.json` to the new heading and run `node site/tools/changelog-to-history.mjs`.
3. Documents on macOS: if they work on a Mac, set `macos-documents` to `available` (see Gates).
4. Standalone package: when the installer ships, write its commands, prerequisites, update and uninstall steps into `install`, copied from `docs/install.md`, and set `binaries` to `available`.
5. Run `sync-status.mjs --check`, `changelog-to-history.mjs --check` and `check-page.mjs`, and look
   at the page at desktop and phone widths.
