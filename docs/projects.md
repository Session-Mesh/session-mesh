# Projects

**Sessions** and **Projects** are main modes in the same application. Projects has its own
sidebar and contextual **+ New** button. A project needs only a name; **Project settings** can
add a description, several local folder references, a repository URL and source or workflow
references. The local overview displays this authored context. Saving a folder does not create
or inspect it; saving a repository or source does not contact it or connect an account.

The normal native PTY host owns all registry reads and writes. It fixes the registry path at
startup: `$MESH_CONF_DIR/projects.json`, or `~/.config/session-mesh/projects.json` when the variable
is unset or empty, on Linux and macOS. The directory must belong to the host user, must not be a
symlink and must not be writable by group or others. The host writes a private temporary file,
syncs it and atomically replaces the registry with mode 0600. A registry error stays local to
Projects; Sessions remains available. The isolated-agent profile does not support
these operations. The supported transport is the existing local trusted UNIX socket; remote
encrypted project operations are not enabled.

The web server adds only one thin authenticated POST bridge, `/api/projects/v1`, to the existing
host API. It checks the closed project-operation allowlist and request size, then returns the
host reply. Existing cookie, Origin and session-token rules apply; session tokens cannot use it.
The allowlist includes the four observation operations (`project_observation_start`,
`_status`, `_page` and `_cancel`); the bridge forwards them without interpreting them, and the
native host decides whether a start is admitted.
The server does not read or write the project registry.

Settings carry the revision that the editor opened. If another client saves first, your draft
stays open and the stale save is refused. If an acknowledgement is lost, **Check saved state**
uses the original request identity; creating another project automatically would risk a duplicate.
The browser retains that pending intent in its tab session storage, not the registry. You can
explicitly retain the current state, retry the original create, or review a settings draft when
the host cannot confirm an old receipt. Project IDs survive renaming and host restarts.
Untouched fields retain their original text, including line endings and folder whitespace.
If a folder list cannot be represented safely as separate lines, its editor stays disabled
with an explanation; other settings remain editable.

The durable schema retains its 2 MiB bound. Native requests are limited to 128 KiB and replies
to 192 KiB. A project can contain up to 100 folder references and 20 source references.
A settings request can carry up to 40 distinct source changes, allowing 20 removals and
20 additions in one replacement; the final project still has at most 20 sources.
Capabilities publish these separate limits. Large detail fields are omitted whole and their editors disabled, so changing a
title does not replace hidden metadata. Unsupported schema fields or features are refused
without rewriting the file. Older catalog tools may refuse the new workspace feature; keep
their existing catalog artifact for the read-only view rather than asking them to rewrite it.

Returning to Sessions keeps its terminal panes, drafts, viewport and exact action targets
mounted. Projects has no authority to accept provider work or start an agent.

The **Timeline** uses one shared clock axis for every task. Each recorded attempt has its own
position, outcome and duration, including failed and interrupted attempts before a retry.
Open attempts stop at the observation timestamp, not at the viewer's current clock. A pipeline
completion timestamp is a point; it does not imply an implementation or review interval.
Missing timestamps and truncated history remain explicit rather than becoming zero-length work.

Dashed future bars are conditional projections of validated remaining estimates through known
prerequisites, assuming unlimited capacity. Unknown or blocked prerequisites prevent a branch
from being positioned; unrelated unknown tasks do not erase a qualified branch. Stale estimates
requiring revision are not projected. These bars are not the provider's global ETA or evidence
of active workers. The provider's forecast and its assumptions remain displayed separately.

## Observe from the native runner

The native Projects workspace can collect Git and selected Roster observations without
asking the web server to inspect files or execute providers. In **Project settings**, save
the repository or Roster selector, then explicitly enable the corresponding observation.
Saving a reference alone grants no execution permission. Roster is optional.

Build the browser assets and runner collector from the same checkout:

```sh
npm run build:projects
```

Before launching a new native host, configure its trusted executable paths:

```sh
export MESH_PROJECT_OBSERVATION_RUNTIME=/absolute/path/to/node
export MESH_PROJECT_OBSERVATION_ENTRY=/absolute/path/to/session-mesh/tools/project-observation.mjs
export MESH_PROJECT_ROSTER_CLI=/absolute/path/to/roster-roadmap
export MESH_PROJECT_ROSTER_PIPELINE_CLI=/absolute/path/to/roster-pipeline
```

The last two paths are needed only for the respective enabled Roster sources. The host
does not discover or install these tools. These are startup settings; setting them in a
different shell does not change an already running host. Do not restart a host that owns
active sessions merely to change these settings.

An observation starts asynchronously. Its initial acknowledgement means that the runner
reserved the request; it does not certify captured data. The browser reads bounded pages,
verifies their digest and scope, and checks the current registry identity before displaying
the result as current. Changing the project invalidates its older observations. Leaving
the view does not cancel collection; cancellation is an explicit operation.

The runner admits two active observations and retains at most four completed catalogs,
each bounded to 2 MiB. Results expire after 120 seconds. Saturation refuses another start
instead of queuing it. An unconfirmed provider shutdown keeps its capacity charged until
settlement is established. Registry operations and Sessions use separate paths.

This path currently uses the existing local authenticated bridge. It does not enable
remote encrypted Projects operations or turn inert Slack/Linear references into connected
accounts. The standalone catalog flow below remains available separately.

## Load an existing read-only catalog

The **Existing read-only catalog** section reads a catalog generated from an explicit local registry. It keeps project identity
separate from Sessions and displays provider observations without accepting, starting or changing
provider work. Session associations remain unresolved references; an owner-supplied machine label
does not establish that a session belongs to the running Mesh server.

## Generate a catalog

Use a supported Node version (22.13+ or 24+) and the repository's existing npm dependencies
(`npm ci`). Create a private
`projects.json` file outside your provider data roots:

```json
{
  "kind": "mesh-project-config",
  "schema_version": 1,
  "machine_id": "workstation",
  "projects": [
    {
      "id": "garden",
      "title": "Garden",
      "description": "A stable project, independent of its repository name.",
      "repository": { "url": "https://example.com/team/garden" },
      "sources": [
        { "id": "roadmap", "kind": "roster", "label": "Delivery roadmap", "board_path": "/home/me/garden/roadmaps/launch" },
        { "id": "issues", "kind": "github", "label": "Issues", "url": "https://example.com/team/garden/issues" }
      ],
      "sessions": []
    }
  ]
}
```

Run from the repository, selecting local provider executables explicitly:

```sh
npm run snapshot:projects -- --config /home/me/projects.json \
  --output /home/me/project-catalog.json \
  --roster-cli /home/me/bin/roster-roadmap
```

Open **Projects** in the local Mesh interface, enter the absolute catalog path and choose
**Load / retry**. Select a project to inspect its sources and observation times. **Back to
Sessions** returns to the mounted session. Generate the artifact again and load it to refresh
the observations; the interface does not run providers or refresh the file automatically.
The top bar contains **Projects**; on phones, use **Actions → Projects**. The absolute catalog
path is saved in this browser's localStorage for the next visit. Signed capability URLs stay
in memory and are never saved with that path.

Omit `--output` for JSON on stdout. Both config and output names must end in `.json`.
No executable is discovered or installed automatically. Executable flags accept absolute paths
to programs the owner trusts. A Roster executable must directly support `view BOARD --events 0`
(the canonical `roster-roadmap.cjs` has an executable Node shebang).
In the catalog, the kinds `slack`, `teams`, `linear`, `github`, `gitlab` and `other` are
references, not connected accounts. In the native workspace, `github` and `gitlab` sources can
also list issues (see [Read issues](#read-issues-from-github-or-gitlab)).

## Read issues from GitHub or GitLab

A source of kind `github` or `gitlab` whose URL points to a repository on `github.com` or
`gitlab.com` (optionally ending in `/issues` or `/-/issues`) adds a **Read issues** action in the
**Work** view. The web server runs `gh api` or `glab api` (found in `PATH`) with a GET request and
your existing login; it needs no startup variable. Issues are listed 25 per page, up to 20 pages,
most recently updated first, with state, labels, assignees and a description cut at 32,768
characters. Pull requests are left out. The read is explicit, bounded (two at a time, 20 seconds)
and read-only: nothing is written to GitHub or GitLab. Without the matching command-line tool,
Projects reports that the provider is not configured for local reading. Other hosts and Linear are
not supported. The route is `POST /api/projects/issues/v1`, with the same authentication as the
other Projects routes.

## Views and the document reader

A project opens on **Overview**; the other views are **Work**, **Roster**, **Repository**,
**Sessions**, **Activity** and **Sources**. **Work** shows tasks as a Kanban board, a dependency
graph or the Gantt **Timeline** of recorded attempts described above (the Kanban board is not
offered for a recorded pipeline). Projects has no beta setting.

The **Roster** view can read a Roster task's documents. It requires
`MESH_PROJECT_ROSTER_PIPELINE_CLI` (and `MESH_PROJECT_ROSTER_CLI` for roadmap tasks) in the web
server's environment; without them it shows "Document reader is not configured on this server" and the
Roster tasks remain available.

## Observe a recorded Roster pipeline

Pipeline observation uses an experimental, closed compatibility profile and requires a
matching standalone tool supplied explicitly by the owner. The public Roster roadmap
observer at revision `757bf97` works with roadmap sources. Its pipeline output has a
different schema identity and evidence shape; it currently produces a source-local
unavailable result here. It is not silently converted to success or an empty pipeline.
Core Projects catalogs and metadata references remain useful without pipeline support.

A Roster source can select one pipeline task instead of a roadmap. Configure both
`pipeline_root` (the absolute directory containing `briefs/`) and `pipeline_task`:

```json
{
  "id": "release-pipeline",
  "kind": "roster",
  "label": "Release pipeline",
  "pipeline_root": "/home/me/garden",
  "pipeline_task": "release-check"
}
```

Use `--roster-pipeline-cli /home/me/bin/roster-pipeline` when generating the catalog.
This is separate from `--roster-cli` for roadmap sources. The selected program must support
`show --root ROOT --task TASK --history-limit 50`; this describes the experimental local
observer contract, not a command guaranteed by a released Roster package. Each configured source gets exactly one read;
the producer does not discover tasks, follow cursors or associate roadmap task names with pipelines.
The pipeline pair and `board_path` are mutually exclusive. Root paths are bounded to 2000 UTF-16
units and task names to 120 lowercase letters/digits with single hyphen separators. Generic Mesh
project/source identities keep their existing 80-unit limit.
The observer's `schema.id` is a strict opaque compatibility identifier. It is not fetched
as a URL and does not authenticate its publisher or establish ownership of its domain.

Native project detail shows recorded phase history separately from current review, QA JSON and
QA document status. The latest recorded phase is the last ledger entry, not evidence of currently
running work. Current reports are not associated with historical events. Conflicting current
verdicts remain explicit; a missing report or unknown total is never converted to success or zero.
An observation can be available while one or all underlying components are absent or invalid:
the observer returned that evidence successfully. Malformed/mismatched observations instead make
that source unavailable while other sources can publish fresh observations.

History includes only the first 50 canonical append positions, with total/partial labels; positions
identify events within that observation, not immutable attempts. Current report summaries retain
status, round/cycle/date, bounded findings (severity/description/status/specialist), round audits
(round/date/verdict/qualifying/causes), reason type/cause/failed-criterion labels and the QA NO-GO
round where supplied. Findings and round lists retain at most 100 entries and preserve unknown
totals and source truncation. A component-wide partial flag describes the canonical source summary;
it does not specifically assert that findings were omitted.

Recorded actor labels are not authenticated users or session identities. Original event times and
report/audit dates remain inert source labels. A valid, explicitly zoned calendar timestamp may
position a recorded completion point, but does not establish an execution interval or current activity.
Generated metadata separately keeps its UTC format. The catalog omits raw source roots, component
source paths/digests, cursors, evidence/path/line locations, commands, transcripts, Markdown previews,
manifest targets, cross-runtime detail and severity aggregate counts. Observer coverage is labelled
separately from this selected view: standalone accepted checks, live execution, session/attempt
identity, full historical reports and standalone acceptance remain unsupported. No controls execute
reported commands or activate work.

Pipeline output uses the existing process, aggregate byte/time and atomic-publication limits.
Output cannot lie inside a configured pipeline root. A refused whole configuration, aggregate or
publication preserves the prior artifact; a valid new catalog can replace it with fresh successful
sources and explicit unavailable status for a failed provider.

The producer validates the entire config before provider reads. A configured provider without
its executable, a timeout, an unsupported response or invalid data produces an `unavailable`
source; other projects and sources remain visible. A source without a locator is `unconfigured`.
Neither state means no tasks or completed work. Provider errors use stable codes and do not copy
stderr, filesystem exception messages or arbitrary provider fields into the catalog.

Keep the config and output under local owner-controlled directories. Output cannot replace the
config, a symlink, a hard-linked file, a non-regular file or any path with a symlink ancestor,
or any path inside a registered Roster
board root. Publication uses a private `0600` temporary file in the destination
directory, fsync and rename. A config or serialization failure preserves the previous artifact;
that previous artifact remains old until generation succeeds. Temporary files are removed after
caught failures. An uncatchable termination may leave a private temporary file, never a partial
catalog at the final path. No source registry is edited or chmodded.

## Browser contract

`static/project-catalog.ts` exports `parseProjectConfig(value)` and
`parseProjectCatalog(value)`. Both accept parsed data or a JSON string, return a normalized
allowlisted copy, and return `null` on invalid input. Unknown config/catalog fields are rejected.
Catalogs identify themselves with `kind: "mesh-project-catalog"`, `schema_version: 1`, opaque
owner-assigned `machine_id`, opaque `revision`, UTC `generated_at`, and `projects`.
Project identity is the pair `(machine_id, project.id)`; titles and paths never replace it.
Catalog projects require explicit `sources` and `sessions` arrays.

Each source has `id`, `kind`, `label`, optional safe `url`, `status` and `observed_at`.
Only available sources have `summary`; only unavailable sources have `error_code`.
Locators and executable paths are not published. Summaries contain provider schema/version,
source generation time/revision when supplied, allowlisted counts, bounded items and truncation
metadata. Each item has `id`, `title`, `state` and optional dependencies, attempt count and checks.
Checks distinguish `accepted_status` from `reported_status`; reported success never grants
acceptance. Roster's `global_accepted` is independently sourced from `global.accepted` and is
never inferred from task counts.

Roster operator requests have their own summary list plus `operator_status`
(`absent`, `valid`, `invalid`), `operator_truncated` and `operator_*` counts. An invalid annex
does not erase an otherwise available roadmap. This list is advisory; it grants no authority.
The catalog drops native commands, evidence paths, raw errors, transcripts, unknown fields and
credential fields. Source prose is still owner/provider data and may contain sensitive content:
do not store secrets in titles, goals, request text or links. The producer is not a secret scanner.

`observed_at` records completion of this provider read, `source_generated_at` records when the
provider generated its document, and catalog `generated_at` records snapshot assembly. None proves
that the underlying source was recently updated. `revision` identifies one catalog observation,
not authenticated source identity. Source totals and visible-item counts are distinct. `truncated`
means bounded detail was omitted; `more` counts omitted primary task items when known and is
`null` when advisory truncation makes one aggregate omission count misleading. This catalog does not import entire source documents or histories.

Session associations contain `name`, exact finite numeric `created` incarnation and optional
`machine_id` as inert provenance. They contain no command, resume URL or actionable target.
Provider metadata remains inert text. Repository README previews are secondary, collapsed by
default, and render Markdown through the document viewer's local parser and sanitizer. They
cannot load embedded resources, create controls, inject application IDs/classes/data attributes,
or activate relative paths against the Mesh UI. Explicit external links allow only HTTP(S), without
userinfo. The browser obtains an exact-file signed `/view` descriptor for the selected JSON
artifact; a refused file remains unavailable. Capability URLs must stay in memory and must not
be copied into preferences or logs.

Catalog reads support loopback HTTP and HTTPS. Non-loopback plain HTTP is unsupported:
browsers may omit `Sec-Fetch-Dest`, causing the signed viewer's safe document fallback to
return HTML instead of JSON. Projects then reports the catalog unavailable. Use loopback
or HTTPS; this feature does not change the viewer's isolation or authentication rules.

## Resource bounds and assurance

Config/catalog UTF-8 size is at most 2 MiB; 100 projects, 20 sources per project, 1000 sources
overall, 200 items/checks/requests per provider list, and 100 session associations per project.
Identifiers use at most 80 ASCII letters, digits, `_` or `-`; titles/labels use 240 UTF-16 units,
descriptions/goals 4000, and paths 4096. Provider text outside the normalized bounds makes that
source unavailable rather than silently changing its assertion.

At most four provider reads run concurrently, with a 5-second deadline each and a 30-second
aggregate provider-run budget. Stdout is capped at 2 MiB and stderr at 64 KiB while streaming.
Output must be one fatal-decoded UTF-8 JSON document and exit successfully. On POSIX, deadline
and completion cleanup kill the invocation's owned process group, including descendants retaining
pipes. The producer reserves publication bytes for all metadata before launching providers, then
accounts for each normalized source before retaining it or launching the next read. If the
complete catalog can no longer fit 2 MiB, it refuses generation, stops further launches, cancels
in-flight provider groups and preserves the previous output. At most four bounded responses can
be in flight alongside admitted observations; it never accumulates every response to discover
aggregate overflow. No additional detail is silently dropped to make the artifact fit.

Selected programs are trusted local code: fixed arguments and no shell are not a sandbox;
a deliberately escaping descendant or filesystem writes by that program are not prevented.
Local filesystem operations assume responsive, owner-controlled directories; adversarial concurrent
replacement of parent directories is outside this boundary.

Run the data checks with:

```sh
npm run typecheck:projects
npm run build:projects
node tools/build-projects.mjs --check
node --experimental-strip-types --test tests/project-catalog.test.ts tests/project-snapshot.test.ts
```

`npm run check:projects` additionally runs the UI tests. Set `MESH_CHROMIUM` to a local Chromium
executable, `MESH_PYTHON` to an existing Python environment with the server dependencies, and
`MESH_REQUIRE_BROWSER=1` to require the browser cases. The real-server case starts the existing
server and PTY host with a throwaway HOME/config/runtime, checks a hostile catalog through
authentication and signed `/view` under the actual CSP, then stops only those child processes.
It does not attach to an owner's browser or services. The build produces browser
ESM files with no module-load UI effects. Only Roster has an executable integration; other source
kinds remain metadata references.
