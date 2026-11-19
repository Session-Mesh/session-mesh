# Changelog

All notable changes to session-mesh. Versions follow [semantic versioning](https://semver.org/);
before 1.0, a minor version may change behaviour.

## Unreleased

- **An agent records the owner's answer to its question.** `mesh-work` gains an 18th tool,
  `work_answer` (`question`, `text`, optional `answered_by`, default `owner`). The owner answers a
  question asked with `work_ask` in an agent session (the asking one or another), and the agent
  records those words; the tool description, the server instructions and the agent guide say that
  it relays the owner's answer and is never used to answer without the owner. Nothing verifies
  that the words are the owner's. The tool refuses to write without a session identity
  (`MESH_SESSION`), so every answer it records names its relaying session. A question has one answer: the
  same answer repeated returns `duplicate: true` and writes nothing, a different one is refused
  with the new error code `already_answered`; two writers racing on one question record exactly
  one answer. The data format is unchanged (the `answer` event already existed); the event now
  also carries the relaying session's `agent` and `session`, returned as `relayed_by_agent` and
  `relayed_by_session` with each answer. The recording logic is the library function
  `Work_questions.answer_once`, which a later answer button in the Projects view is meant to call
  as well; it refuses control, invisible and bidirectional characters itself, not only through
  the tool's argument check. The task sheet now shows each answer as the owner's answer relayed
  by a named session and not verified (an `answered_by` other than `owner` appears only as the
  stated answerer), and tells the owner to answer an open question in an agent session with
  `mesh-work`; answering from a button comes later. See [docs/work-mcp.md](docs/work-mcp.md#answering-a-question).
- **A new Projects view over the project tracker.** The Projects mode now opens on a read-only
  view of the tracker that agents write with `mesh-work`: the products and their active projects
  with progress and blocker counts, a project in four tabs ("Pick up", "Board", "Timeline",
  "Dependencies") and a task sheet with its blockers, dependencies, sessions, notes, events and open
  questions. The browser reads it through `POST /api/work/v1`, which runs `work-read` with the web
  server's `HOME` and `WL_HOME`. The data is a local git repository, `WL_HOME` or else
  `~/worklog-data` (or an older `~/worklog`), created by an agent's first `work_*` call. Nothing is
  written from the view, questions cannot be answered there yet, and `work_open_view` still answers
  that the view is not available. The previous workspace stays behind the "Old view" button, and
  is shown once per page load when `work-read` is not installed. See
  [The Projects view and the project tracker](docs/features.md#the-projects-view-and-the-project-tracker).
- **A project configuration edit that meets another writer's lock reports `busy`, never
  `invalid-config`.** When the other writer released its lock between the failed exclusive create
  and the inspection of the lock file, the vanished lock was reported as a missing configuration.
  The edit now refuses `busy`, and the caller retries with a fresh revision as for any other busy
  lock.
- **The session list is computed with less repeated work.** Each listing re-decoded every line of
  the Codex rollouts and Claude transcripts it shows, even unchanged ones, listed the recent Codex
  rollouts once per identity rule, serialised the conversation-name file once per session, and
  validated the whole process table once per observed session. An unchanged transcript is now
  parsed once (the cache is keyed by path, device, inode, size and modification time, so a written,
  replaced or relinked file is read again), the rollouts are listed once per listing, the names are
  serialised only to be written, and each process table is indexed once. The folder and id read
  from the first line of each recent Codex rollout are also kept in `codex-rollout-meta.json` in
  the cache directory (mode 0600, ids and folders only), so the first listing after a restart of
  the web server does not read every rollout again. The listed data are unchanged.
- **A message approval answered in one window closes in the others.** The "Message from another
  agent" question opens in every window of the mesh. Once one window answers it, the others close
  it at their next refresh of the session list instead of leaving it open and say so in the page's
  status message. When another request is pending, its prompt opens once the closed one has
  finished closing and says in its own status line that the previous request was decided
  elsewhere, since the page's status message is unreachable behind a modal dialog. A window that
  still answers in between, or whose answer is overtaken by that refresh, gets "Message request
  decided elsewhere; your choice changed nothing." The server already kept only the first answer.
  See
  [Messages and requests from agents](docs/features.md#messages-and-requests-from-agents).
- **An idle Codex started as `codex resume <id>` gets its conversation id from its launch
  arguments.** Such a session that holds no rollout file open had no conversation id, so a PTY host
  restart brought it back as a plain shell. The id is now read from the launch arguments of the
  running Codex process: the word after the `resume` subcommand, a lowercase UUID; `--last`, other
  values and an option before `resume` that is not in Codex's option table give none. The launch
  arguments say where the session started: after `/new` or `/resume` inside Codex they can name an
  older conversation. When the session's folder has a later conversation (a rollout of another id
  written since the process started, which no other running Codex holds open or was launched on),
  the id is withheld and the existing folder rule applies, as before this change. A `/resume` of a
  conversation of another folder is not detected: the restore then reopens the launch conversation.
  The id is also withheld when another running Codex may run the same conversation (it names that
  id in any form, was started as `codex resume` without a readable id, or holds that rollout open),
  and dropped together with any other session that reports the same id. A rollout the Codex holds
  open is used instead while it is open, and a difference is noted once in the web server log. See
  [Restoring sessions](docs/operations.md#restoring-sessions-after-a-pty-host-restart).
- **An idle Codex is no longer given the conversation of a Codex started later.** When a Codex
  session holds no rollout file open, its conversation was inferred from the newest rollout of its
  folder, and a single candidate was accepted even when several Codex ran there: an idle resumed
  Codex could be given the conversation of one started later, and a restore would then resume the
  wrong one. The inferred id is now accepted only when exactly one Codex runs in the folder, no other
  Codex holds that rollout open and the process table could be read; an inferred id that another
  session also reports is dropped. This holds while the later Codex is still running. Two cases are
  not covered and remain: a Codex that already exited after writing its rollout, and a finished
  `codex exec` run (its rollout `source` is the plain string `exec`, which is not recognised as a
  sub-agent). In both, the idle Codex can still be given that rollout's conversation; closing them
  needs the conversation registry planned as a later change. A Codex of another user that cannot be
  inspected is skipped (it cannot hold this user's rollouts); one of the same user that cannot be
  inspected keeps the id unknown. Effect: some idle Codex sessions are now restored as a plain shell
  instead of possibly the wrong conversation. Exact ids are unchanged. See
  [Restoring sessions](docs/operations.md#restoring-sessions-after-a-pty-host-restart).
- **The session list no longer falls minutes behind on a busy machine.** Each `GET /api/sessions`
  ran its own listing, one after the other; when a listing took longer than the page's 4-second
  poll (after a web server restart on a loaded machine), requests queued faster than they were
  answered and the list could stay empty for minutes. Requests that arrive while a listing runs now
  share the next one, so the wait of `/api/sessions` requests no longer grows with the number of
  polling pages; the background loops still run their own listings under the same lock.
- **Copy on select.** Selecting text in a terminal now copies it to the clipboard when you release
  the mouse button (or lift your finger after a long press on a phone), and the text stays
  selected. It is on by default and is a per-browser preference (`copyOnSelect` in the page's
  client store; `false` turns it off). Nothing is copied while a program tracks the mouse unless
  you force the selection with `Shift`+drag (`Option`+drag on macOS). See
  [Working in a terminal](docs/features.md#working-in-a-terminal).
- **Copy as shell command.** `Ctrl+Shift+X` (`Cmd+Shift+X` on macOS) in a terminal copies the
  selection with the `\` continuations of a multi-line command: rows the terminal soft-wrapped are
  rejoined, and a trailing `\` is added only before an indented option row (`-x`, `--long`) when
  every row after the first in the block is such a row. A continuation that does not start with
  an option is not joined, nothing is guessed from indentation, and separate commands, heredocs,
  quoted strings and comments are left unchanged. The usual copy is unchanged.
- **Releases ship `work-read` and `work-mcp`.** Every bundle now holds `bin/work-read` and
  `bin/work-mcp`, and a release publishes both programs for `linux-x86_64`, `linux-aarch64`
  (static executables) and `macos-arm64`, checksummed and attested like the others: 30 files
  instead of 24 (29 instead of 23 without the macOS bundle). A release install therefore answers
  `/api/work/v1` instead of a 503; a release installed from its native programs links
  `app/bin/work-read` to its own. See [docs/work-read.md](docs/work-read.md).
- **Agents get the project tracker.** Every agent that receives `mesh-board` (Claude Code, Codex,
  Pi, OpenCode, Gemini CLI, Copilot CLI and Mistral Vibe started by the mesh, and Antigravity
  through its plugin, once installed again) now also receives a second MCP server, `mesh-work`
  (`work-mcp`, 18 `work_*` tools), with the agent kind as `WL_AGENT`. The session name and
  `WL_HOME` come from the agent's environment; no token, session name or data directory is written
  into a configuration or a command line. One list of servers and one rule serve every agent:
  without the board bridge, no server; without `work-mcp`, the launch is unchanged. `mesh-board`
  and `mesh-work` are reserved names: a user's definition under them is replaced, a user's
  restriction on them is kept (for Pi, a user's `"enabled": false` on `mesh-board` is now kept
  too). A release installed from its native programs links `app/bin/work-mcp` to its own. The
  agent guide gains a short "Track your work" section that says which system to use for what,
  checked against the server's real tool list. See [docs/work-mcp.md](docs/work-mcp.md#registration).

## 0.1.1

A patch release of the 0.1 line: fixes, a native `mesh-logout-all`, and documentation.

- **Idle sessions no longer show as working.** A Claude Code or Codex session that had been idle
  for hours could be listed as working in the sidebar. Claude Code's own status is now
  authoritative, and for Codex a session needs two consecutive 10-second windows at 5 % of a core
  or more to be promoted; a question or permission prompt is still always shown. Other agents are
  unchanged. A Codex session whose only work is a silent child process (a long build, say) may
  stay in the inactive list.
- **Clicks reach programs that track focus.** Full-screen programs such as Claude Code ignore a
  click that arrives right after a focus-in, and the terminal sent that focus-in just before every
  click (on a phone, before every tap). Focus reports now follow the pane, so the click is no
  longer dropped.
- **Touch scrolling and a vertical Kanban in Projects.** On phones, the Kanban, Gantt and
  dependency views scroll sideways with the browser's own touch scrolling, inertia included, and
  at 640 px or less the Kanban becomes full-width vertical sections that scroll with the page.
- **`mesh-logout-all` is a native program.** It no longer needs a Python interpreter, ships in
  the bundles and as the release assets `mesh-logout-all-<os>-<arch>` (a release now has six
  native programs), and every install mode, including an upgrade from 0.1.0, links
  `~/.local/bin/mesh-logout-all` to it. The command keeps its contract, and its fallback is
  stricter: the counter on disk is raised only when the mesh sent no byte of an answer; an
  incomplete answer is now an error with a one-line message and exit status 1.
- **The bootstrap uses the pinned opam repository.** `scripts/bootstrap.sh` installs the OCaml
  dependencies from the opam-repository commit pinned for the releases, instead of failing with
  `Package dune has no known version 3.24.2` on a host whose repository is older. It changes only
  the switch it builds into, never re-points a switch shared with other projects without
  `MESH_OPAM_SELECT_PINNED=1`, and prints the command that undoes each change.
- **macOS.** The Configuration dialog reports the PTY host as running, with its kind and
  executable, on macOS as it does on Linux. The local scripts `scripts/test-local.sh` and
  `scripts/check-copyright.sh` run on macOS (bash 3.2 and BSD tools).
- **Documentation.** The Debian and Ubuntu prerequisites list `libsqlite3-dev`, which building
  `mesh-history` needs. The New session dialog's folder suggestions are described in
  [Starting and finding sessions](docs/features.md#starting-and-finding-sessions). New
  [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) text covers the pull request
  workflow, the `semver:` labels and the backports to `release/latest`.
- **Repository and tests.** Ilias Garnier joined the maintainers. The CLA register files follow
  `release/latest` through their own backport workflow, and the opam caches of the CI are keyed on
  the pinned opam repository. The local test suite sets a fixed English locale for the browser
  tests and a bounded concurrency (`MESH_TEST_CONCURRENCY`), and more of its tests run on macOS.

## 0.1.0 (first public release)

The first public release of session-mesh, an alpha. In short:

- **Agents.** Shells, Claude Code, Codex (with and without approvals), Pi, OpenCode, Gemini CLI,
  Antigravity, GitHub Copilot CLI and Mistral Vibe start and resume in a session, and each gets the
  `mesh-board` MCP server for messages, requests, the whiteboard and demos. The level differs per
  agent: wake-ups and state do (below), but the History tab (list, title and full-text search,
  conversation card, resume) and pins cover all of them; two cases are resumed with a command on the
  card rather than a button, and delete exists for Claude Code, Codex, Pi and Gemini CLI only. See
  [Conversation history](docs/features.md#conversation-history) and
  [Messages and requests from agents](docs/features.md#messages-and-requests-from-agents).
- **Restoration.** After a PTY host restart or a loss, one offer is restored exactly (under its own
  name, from its recorded conversation), and the agent mail it held is kept for 24 hours.
- **Wake-ups, per agent.** Claude Code 2.1.325 or later is woken on a messaging socket without any
  typing; Claude Code without a socket, OpenCode, Gemini CLI and Mistral Vibe get a typed notice
  only while idle; Pi is woken by its extension; Codex is woken by `codex queue` only when
  `MESH_CODEX_QUEUE_WAKE=1` is set (off by default); Antigravity and GitHub Copilot CLI are never
  woken.
- **Projects.** Git, README and Roster roadmap tasks are read by the native host, and the issues of
  a configured GitHub or GitLab repository are listed read-only through `gh` or `glab`. Other
  connectors, opening a session from a project and installing a harness are not available.
- **Native PTY host only.** `mesh-ptyhost` in OCaml owns the terminals on Linux and macOS; there is
  no Python PTY host.
- **Install from a release.** `install.sh` with bundles for Linux x86-64, Linux arm64 and macOS on
  Apple silicon, `--upgrade`, `--rollback` and `--uninstall`. macOS support is best
  effort.
- **Interface.** Keyboard shortcuts (`n`, `o`, `?`, `Ctrl+K`), pins for conversations, a phone
  layout with direct writing, and English and French.

The details follow.

- **Exact restore of a lost session.** `POST /api/restore` accepts `{"names": [N], "expected":
  {name: N, created, agent_kind, resume_id, cwd}}`: it restores that offer only if it is still
  exactly that, under exactly that name (no suffix), and answers `{"results": {N: ...}}` with the
  creation date of the new session, or a `code` and a `phase` (`not-started`, `created`,
  `uncertain`). An identified agent without a conversation id is refused (`not-resumable`). A stale
  offer, a taken name or a running conversation is refused before any session is created. The
  intent is written to the snapshot before the creation, with a nonce the session carries, so a
  repeated request finds that session instead of creating another; if the intent cannot be
  written, nothing is created (`not-restored`). Limits: a marked offer whose session is gone
  answers `restore-interrupted` (discard it); the page's `names` restore refuses a marked offer;
  an older server ignores the mark. Requests with `names` otherwise behave as before. See [Restoring exactly one offer](docs/operations.md#restoring-exactly-one-offer-for-tools).

- **Install from a release, upgrade and roll back.** A release publishes a bundle per platform
  (`mesh-linux-x86_64.tar.gz`, `mesh-linux-arm64.tar.gz`, built against glibc 2.28: glibc 2.28 or
  newer; `mesh-macos-arm64.tar.gz`: macOS 13.5 or newer, left out of a release whose macOS bundle
  build failed), which runs without Python, Node, opam or a compiler on the machine: the code, its
  own CPython and Node with locked dependencies, and the native programs (`mesh-ptyhost`, the board
  MCP server `mesh-board-mcp`, `mesh-read`, `mesh-platform`). Each release carries its own
  `install.sh`, stamped with the release tag and the SHA-256 of every bundle. It downloads the
  bundle of the platform for that tag, checks it (and, when `gh` is on `PATH` and logged in, its
  build attestation, which must name the release workflow and that tag;
  `MESH_REQUIRE_ATTESTATION=1` refuses to install without it) and its native programs against its
  manifest, extracts it into `~/.local/share/session-mesh/releases/<tag>/` and points
  `~/.local/share/session-mesh/current` at that release; the units and launchd jobs run from
  `current/` with the bundled Python. An archive that does not match installs nothing. A release
  also publishes the native programs of each platform (`<program>-linux-x86_64`,
  `<program>-linux-aarch64`: static musl executables built in Alpine; `<program>-macos-arm64`) and
  the code archive `session-mesh-<tag>.tar.gz`; for a platform without a bundle in the release,
  or a machine older than the bundle needs (glibc 2.28, macOS 13.5) or on musl, `install.sh`
  installs those, says why, and runs the web server with the machine's Python. `./mesh install` in an extracted bundle runs the same installer, with
  the services running from that directory. Services that already run another extracted bundle
  are left as they are unless `--switch-from-bundle`, and that bundle is never deleted; a switch
  whose web server does not answer gives the old installation its units back. On Linux, a release
  or bundle install, or a switch, refuses before any change while a drop-in of either unit sets
  `ExecStart=`, `Environment=`, `EnvironmentFile=`, `UnsetEnvironment=` or `PassEnvironment=`,
  and names it. A bundle puts only its `bin/`
  on `PATH`: mesh sessions keep the user's own `python3` and `node`. Each bundle carries
  `licenses/THIRD-PARTY.md`, the licence of every component it embeds (CPython and the libraries
  it links, the Python packages, Node, esbuild, the opam packages of the native programs, the
  copied system libraries), checked against a licence allow-list at build time, and
  `licenses/SOURCE`, the repository and revision of its source and the upstream archives of its
  CPython runtime (Berkeley DB included). The runtime ships without pip, ensurepip, IDLE or Tk. `install.sh --upgrade [--to TAG]` installs the latest published release (or
  `TAG`) beside the current one, checking its `install.sh` against its `SHA256SUMS`, switches
  `current`, restarts the web server and goes back by itself when the web server does not answer
  (a first release install over a clone gives the clone its units back, and stops the PTY host
  it started);
  a downgrade needs `--to`. The PTY host is never restarted by the installer, which ends sessions:
  it says whether `mesh-ptyhost` changed and gives the command, or restarts it with `--restart-pty`.
  `--rollback` returns to the previous release; two releases are kept, and on Linux also the one
  the running PTY host was started from. Only units the installer
  wrote are touched, and units written for a clone by an earlier installer are replaced after a
  notice. `--assets-dir` installs from a local directory. See [Install](docs/install.md) and
  [Upgrading](docs/operations.md#upgrading).
- **A native PTY host.** The PTY host, which owns the terminals, is the OCaml program
  `mesh-ptyhost`, on Linux and macOS; there is no Python PTY host and no `--pty-backend` option. A
  release brings it; a source install (a git clone, upgraded with `git pull`) takes it from
  `--ptyhost`, else `mesh-ptyhost` on `PATH`, else the opam switch, and `--from-source` moves an
  account from a release install to the clone. Agents are given the board MCP server of the
  running release or bundle (`MESH_BIN_DIR`), otherwise the one of the opam switch. `ptyhost.py` remains as the Python client
  the server and the scripts use to talk to the host. A source install refuses a PTY unit that runs
  `ptyhost.py`, with the commands to replace it; if such a unit is restarted before that,
  `ptyhost.py` exits with status 78 and prints the same commands and the release path, so systemd
  shows the unit as failed rather than stopped. See [Native PTY host](docs/install.md#native-pty-host).
- **Projects.** A Projects mode beside Sessions. You create a project by name and save its
  folder, repository and source references; they are stored by the native PTY host in
  `$MESH_CONF_DIR/projects.json`, not in the browser. Saving a reference does not read it or
  contact any account. When you enable it for a project, the native PTY host reads the Git
  repository, its README and the tasks of a Roster roadmap, in a separate bounded worker; the web
  server only forwards authenticated requests. This needs the Node collector, and optionally a
  Roster executable, set when the native PTY host starts. The isolated agent keeps Sessions
  working and refuses these operations. The read-only catalog view, from a local
  JSON file, is still available. Showing the recorded steps of a Roster task is experimental.
  A project has the views Overview, Work, Roster, Repository, Sessions, Activity and Sources. Work
  shows tasks as a Kanban board, a dependency graph or a Gantt chart of the recorded attempts. The
  Roster view reads a task's documents when the web server is started with
  `MESH_PROJECT_ROSTER_PIPELINE_CLI` (and `MESH_PROJECT_ROSTER_CLI` for roadmap tasks); otherwise it
  says the document reader is not configured. For a source of kind `github` or `gitlab` with a
  `github.com` or `gitlab.com` URL, **Read issues** lists the repository's issues, 25 per page, with
  state, labels, assignees and a sanitized description, through the `gh` or `glab` command-line
  tool and your existing login. Nothing is written to GitHub or GitLab, and there is no Linear
  connector. Going back to Sessions leaves your terminals open. Other connectors, opening a session
  from a project and installing a harness are not available. See [Projects](docs/projects.md).
- **Configuration and a lighter Management.** A "Configuration" button next to "Management" opens a
  read-only dialog: the effective paths with a "Copy" button, the page version and commit, the
  terminal host and its capabilities, the agents found in `PATH` (versions are not detected: no
  binary is run), the port, whether the request looks like Tailscale (inferred, not checked) and
  the notification and language state. It never shows a token, a key or a file's content. This
  adds the owner-only route `GET /api/config` and needs the web server restarted. "Management"
  is now a compact list of the active Mesh sessions, heaviest first, with the recently stopped or
  lost ones below: the filters, the tokens line, the per-agent summary, the provenance lines and
  one card per external session are gone (external sessions are counted).
- **Editing the launch settings.** In "Configuration", the enabled agents and the allowed work
  folders of "New session" can be edited. The dialog stays read-only until you press "Edit" and
  type the master token: that unlocks editing for 10 minutes (a countdown is shown, and "Lock" ends
  it at once). Each field has a "Default value" button. A save is refused when it names an unknown
  agent, a relative, missing, duplicate or symbolic-link-escaping folder, or leaves no agent or
  folder, and when another tab saved first. It applies to the next session you start, without a
  restart; running sessions are unchanged. It needs the settings file of `MESH_LAUNCH_SETTINGS`
  (see [Restricting folders and agents](docs/operations.md#restricting-folders-and-agents)); without
  one the dialog says so. Every other value stays read-only, and each says where it is stored (mostly
  `MESH_*` variables of the web server's unit) and how to change it. This adds the owner-only routes
  `POST /api/config/elevate`, `POST /api/config/elevate/revoke` and `POST /api/config/launch`; it
  needs the web server restarted. The master token typed again is a confirmation against a wrong
  tap, not a boundary against someone who holds the login cookie: that cookie already gives a
  shell, which can read the token. Credential folders such as `~/.ssh` and Mesh's own
  configuration folder are refused as work folders; a failed "Lock" is shown instead of hidden.
- **Pane mailbox.** The envelope button of a terminal pane opens that session's mailbox: the
  messages it received and sent with their text (shown as plain text, never as markup or links),
  the approval requests that concern it with the usual choices, and its permanent permissions with
  a revoke button; a badge counts pending requests. The long-message dialog moved to the pane's
  "More" menu ("Write in the terminal…"). This adds the owner-only route
  `GET /api/agent-mail/messages`, which changes nothing and grants the agent no read; it needs the
  web server restarted.
- **Web server and PTY host.** A web server and a separate PTY host, the process that owns the
  terminals, installed as two systemd user units by `./install.sh`. Sessions belong to the PTY
  host, so they survive a restart of the web server, and the last 2 MiB of output are replayed when
  a browser reconnects. After a PTY host restart, the page offers to restore the sessions, resuming
  each conversation of an agent that supports it (Claude Code, Codex, Pi, OpenCode, Gemini CLI,
  Antigravity, GitHub Copilot CLI and Mistral Vibe).
- **OpenCode 1.x and 2.x.** Both majors are supported (2.3.0 tested); any other major, or a version that
  cannot be read, is launched bare: no configuration, bridge, plugin or session token, no mailbox, wake or
  state, a notice in the session list, and no resumed conversation. OpenCode 2 is started with
  `opencode --standalone` (its default shared background service is not bound to `HOME`, so the
  configuration and token would not be the terminal's own), with the v2 configuration (`mcp.servers`,
  `plugins`), a v2 state plugin, a `mesh-board` server that is left out when you disabled it, a
  conversation checked in OpenCode's store before it is resumed (v2 creates an empty one for an unknown
  `--session`), and the same mailbox, wake and restore as 1.x. The binary whose version is read is the one
  the launch line names.
- **Sessions and agents.** Shells, Claude Code, Codex, Pi, OpenCode, Gemini CLI, Antigravity, GitHub Copilot CLI, Mistral Vibe or any command, in up to three columns;
  the other terminals of the machine are listed, and an agent running in one can be resumed in
  session-mesh. Folders, names and order are shared by every device. A history of past
  conversations is searchable by title and full text.
- **Documents beside the terminals.** HTML, Markdown, PDF, images and source files, opened
  from a terminal, a dialog or `mesh-open`, in a sandboxed viewer. The sandbox has known limits,
  described in [SECURITY.md](SECURITY.md#documents-that-send-data-out). Without the session
  token, `mesh-open` refuses to use the master token when it recognises a mesh session, which
  prevents an accidental use; [SECURITY.md](SECURITY.md) lists the cases it cannot recognise.
- **Whiteboard and demos.** Each session has an Excalidraw whiteboard and declarative demos that
  it shares with its agent through the `mesh-board` MCP server, with revisions and restore.
- **Messages between agents.** Agents started by session-mesh can message each other; you consent
  before an agent reads a message. An agent can also ask to create a session or restart its
  conversation, which happens only once you approve.
- **Agent guide.** The `mesh-board` MCP server's read-only `agent_guide_read` tool returns
  [docs/agent-guide.md](docs/agent-guide.md), built into `mesh-board-mcp`: how to show files and
  panels to you, use the whiteboard and demos, message other agents and request sessions. The
  tool's description says that the agent runs in session-mesh; the server's instructions repeat it
  for clients that give them to the model (Claude Code does, Pi does not, Codex is not checked).
  The tool takes no argument and sends no request to the server.
- **Two Codex choices.** "Codex" starts Codex with its own approvals and sandbox; the "Codex (no
  approvals)" choice starts it with `--yolo`. Launch settings enable them separately, and an agent
  can never request a "Codex (no approvals)" session.
- **One runtime directory order.** The PTY socket directory is `MESH_RUNTIME_DIR`, else
  `XDG_RUNTIME_DIR`, else a default (an empty variable counts as unset): `/run/user/<uid>` on Linux,
  `~/Library/Application Support/session-mesh/run` on macOS, below the home directory of the user
  database. The native host validates the directory, creates the macOS default with mode 0700,
  and refuses an unusable directory with one line and exit status 1, asking for a shorter
  `MESH_RUNTIME_DIR` when the socket path would exceed 103 bytes on macOS. The server, the clients
  and the installer apply the same order, so they find the socket with no variable set. Sessions
  keep `MESH_RUNTIME_DIR`. See [Replacing the PTY
  host](docs/operations.md#replacing-the-pty-host).
- **Runtime directory hardening (behaviour change on Linux).** The native host now refuses an
  `XDG_RUNTIME_DIR` with a trailing slash, one reached through a symlink, one not owned by you, one
  writable by group or others, and a `/run/user/<uid>` whose mode is not exactly 0700. Before, any
  existing directory was accepted. It fails with one line and exit status 1.
- **Native PTY host: a reader that keeps up is no longer disconnected during a burst of output
  (#578).** The native host queued one `D` frame per PTY read for each attached client, so a
  consumer whose cost is per frame could fall behind a burst of many small frames until its
  queue reached the 8 MiB limit and was disconnected. Pending live output is now merged per
  client into one `D` frame until the writer takes it, up to 64 KiB of payload (one PTY read).
  The replay snapshot, replies and every other frame are never merged. The 8 MiB limit still
  counts encoded bytes, headers included, so a reader that is really blocked is still
  disconnected. The 8 MiB limit applies to each attached client, not to the session: with N
  readers that all lag, the host can hold N such queues. Output that is not merged stays one
  string shared by all clients; a merged frame is a copy per client whose memory is about 1.25
  times its payload, so one lagging client retains about 10 MiB, and four lagging clients
  of 100-byte reads about 24 MiB for 6 MiB of payload each. "Retains" means the reachable heap
  (measured with `Obj.reachable_words`), not the resident set size (RSS) of the process. The change takes effect when the PTY
  host is restarted.
- **Platform library and `mesh-platform`.** The OCaml package gains `ocaml/platform/`
  (`Mesh_platform`), used by the native host for process inspection, the runtime directory and the
  check for a socket left behind by a stopped PTY host, with Linux (procfs) and macOS (libproc,
  sysctl) backends. The diagnostic command `mesh-platform` offers `capabilities`, `runtime-dir`, `snapshot`, `process PID`,
  `command-line PID` and `require FEATURE` (exit status 0 when available, 78 when refused).
- **`processes` socket operation.** The native host serves a read-only process table to clients of
  the same account (refused in the isolated-agent mode). On macOS the server takes process facts
  from it; on Linux it keeps reading `/proc`.
- **macOS support.** On macOS these work: the native PTY host, the server, agent detection in mesh
  sessions and in external terminals, recovery from a socket left behind by a stopped PTY host, and
  documents beside the terminals and in the Projects catalog. Documents also open from your private
  temporary directory (the one `getconf DARWIN_USER_TEMP_DIR` reports). As browser profiles are on
  Linux, these are refused under `~/Library`: the login keychains; the Safari, Firefox, Chrome
  (including Beta and Canary), Chromium, Brave, Edge, Vivaldi, LibreWolf, Arc and Opera data; Apple
  Mail, Thunderbird, Messages, Contacts, Calendar, Notes and internet accounts; 1Password and
  Bitwarden; Signal and Slack ([SECURITY.md](SECURITY.md)). When macOS forbids the server to read
  one of these folders, as it does without Full Disk Access, that folder is refused and logged
  once, and other documents still open; if the keychains cannot be read, every document is
  refused. The isolated agent and the demo sandbox are Linux-only; there is no macOS CI yet, and
  the PTY host is native only. See
  [macOS](docs/operations.md#macos).
- **macOS installer with launchd.** On macOS (12.3 or later), `./install.sh` installs the native
  PTY host and the web server as two launchd jobs in `~/Library/LaunchAgents`
  (`io.session-mesh.pty`, `io.session-mesh.web`), restarted after a failure, with logs in
  `~/Library/Logs/session-mesh/`. Without a graphical login, over SSH for example, they keep
  running after you disconnect, but only until the Mac restarts; `--at-boot` installs them instead
  as daemons in `/Library/LaunchDaemons` that start at boot as your account with nobody logged in,
  after listing its `sudo` commands and asking for one confirmation (verified on macOS 15 across a
  reboot with nobody logged in). Both jobs receive the same `MESH_RUNTIME_DIR`, chosen in the order
  given under "One runtime directory order" above (an installed PTY job's value first). Rerunning
  keeps the port and never restarts the PTY host; `--uninstall` removes the web job only, as on
  Linux.
  See [macOS](docs/operations.md#macos).
- **Message notices typed only into an idle agent.** The notice that messages are waiting is typed
  into Claude Code only after it reports the end of a turn and before any new input, so its
  `Enter` cannot answer an approval prompt. Codex receives no typed notice.
- **Claude Code woken without typing.** With Claude Code 2.1.325 or later, a Claude session that
  session-mesh launches (new, resumed from the history, resumed, restored, restarted) gets its own
  messaging socket when Claude will deliver the line without asking, and the notice that messages
  are waiting arrives on it as a message from another session: nothing is typed into the terminal.
  session-mesh does not change Claude's `crossSessionInbound` setting. A session keeps the typed
  notice when that setting is `refuse` or `hold` at any level (administrator policy, `--settings`,
  your user settings, the project, including `settings.local.json` at the git repository's root),
  when it is unset and the session bypasses permissions, or when a settings file cannot be read.
  If the agent does not look at its inbox within 20 seconds of the line, the wake is shown as
  unconfirmed in the page and in the session's Mailbox panel, and nothing is typed: a typed
  `Enter` could answer an approval dialog Claude opened for the line. If the remembered state is
  lost or damaged (or its directory stops being private after a line was recorded), every session
  alive then is put in doubt until it restarts: no line, no typed notice, and a read of the inbox
  does not lift it, so such a session is not woken by any means until its restart. A session also
  needs the bridge's `--mcp-config` entry in its command to get a socket. Claude creates a
  messaging socket for every session anyway; see SECURITY.md.
- **Restored agents use the current board.** A restored or resumed Claude Code or Codex session gets the
  current board MCP server and event hooks, replacing any recorded from an earlier installation.
- **Pi.** Pi 1.3 or later can be started and resumed with session-mesh's MCP server, and receives
  message notices through a small extension.
- **OpenCode conversation identity (behaviour change).** The conversation an OpenCode plugin reports
  (`identity_source` `opencode_hook`) now replaces the one found from the process's `--session`
  argument, so after a restore with `--session A`, opening conversation B makes B the one that is
  resumed. Before, the reported conversation was used only when none was found. Gemini's hooks still
  only fill in a missing conversation. See [OpenCode sessions](docs/features.md#opencode-sessions).
- **Interface in English and French**, chosen from the browser's languages or a selector.
- **Phone layout and push notifications**, minimal by default. In a Claude Code, Codex or Pi
  session, a phone input line that starts with `/` (or `$` in Codex) switches to direct writing:
  what you type goes to the terminal as you type it and the field stays empty, so the agent shows
  its command and skill completion and the terminal is what you read. Multi-line text is sent as
  one bracketed paste or refused, never as keys, and a keyboard correction is refused rather than
  added to the word. Enter, and every key of the bar that writes into the agent's line (Esc, Tab,
  the arrows, "↵ line", Ctrl, Paste), first deliver, in order, any word the field still holds, and
  are refused, with a message, while a word is being composed or when the held text could not be
  delivered as typed (a keyboard that keeps Enter for its own composition sends nothing and shows
  no message). The mode ends on Enter, a control key, a send from the
  composer or the attachment menu, the chip (nothing is sent), another pane or view, a lost
  connection, or the agent leaving the foreground; keys typed in the seconds before the session
  list notices that can still reach the program, which the message says, and the next ordinary
  line (or the bar's ⏎) is held back once, for 30 seconds at most, with a warning ([Phone](docs/features.md#phone)).
- **Loopback only by default.** The web server refuses a non-loopback listen address unless
  `MESH_ALLOW_NON_LOOPBACK=1` is set.
- **Tailscale is optional.** The installer works without it; `--tailscale` publishes the interface
  on your tailnet with `tailscale serve`, never Funnel.
- **License and contributions.** AGPL-3.0-or-later. Contributions are accepted under a contributor
  license agreement ([CLA.md](CLA.md)), checked on every pull request.

Hardening from the final security review of the release candidate:

- Every page under `/static` carries the Content-Security-Policy of the file it resolves to:
  `/static/index.html` runs under the interface's policy, `/static/board.html/` under the
  whiteboard's, and any other file opened there as a document runs nothing.
- The document panel also refuses shell and REPL histories, container, Docker and Composer
  registry logins, sops age keys and the Firefox, Chrome, Chromium and Brave profiles
  ([SECURITY.md](SECURITY.md)).
- A frozen PTY host gives 503 instead of 500 on Python 3.10 as well.
- `/view` also checks the file it opened, and the directories above it up to the view root, against
  the protected files, not only the requested path: a hard link to a protected file, or a
  protected directory renamed into place or reached through a symbolic link, substituted after
  the checks gets 404. For a directory refused by name only this covers the directory itself, not
  the directories inside it: one of those renamed into place is not detected, nor is the directory
  itself moved away and back again within the few system calls of the final checks
  ([SECURITY.md](SECURITY.md)).
- The PTY host treats an empty `XDG_RUNTIME_DIR` as unset, refuses to start over a file that is
  not a socket instead of deleting it, and, when out of file descriptors, logs one line per failed
  accept and retries every 0.5 s (so while the shortage lasts, two lines per second, not one per
  connection attempt and no traceback).
- The native PTY host reports a missing runtime directory in one line and exits with status 1.
- A malformed escape in the interface's URL hash no longer stops the page from starting.
- A session-opened marker table holding NaN or Infinity, or replaced by a dangling symbolic link,
  counts as unreadable: documents get file-only scope, as for any other damaged table.
- The installer keeps a port set by hand in the unit or in a drop-in, and refuses a `MESH_PORT`
  line it cannot read instead of falling back to 7690.
- A symlinked or shared session-request database stops the server with one line instead of a
  traceback at each restart; only the three most recent damaged copies are kept.
- README: with `MESH_TRUST_PROXY=1`, the proxy must overwrite `X-Forwarded-Host` and
  `X-Forwarded-Proto`, not pass them through.

Terminal display:

- A terminal you come back to (focus, or the page visible again) redraws itself when output
  arrived while it was not in use and another client was attached to the session, since that
  output may have been drawn for the other client's width. The redraw happens even when the
  session already has this terminal's size; without that evidence, coming back only sends the
  size, as before. A terminal that stayed focused on a visible page while another device drove
  the session is not redrawn when used again: "Redraw the terminal" repairs it.
- A terminal whose connection drops and comes back (web server restart, network) no longer shows
  its history twice: the replay now starts from a reset terminal, as on a first attach. The modes
  that change how keys and the mouse are sent (application cursor and keypad keys, bracketed
  paste, mouse tracking and its encoding, focus reports) are kept across the reset. Lost with it,
  as on a first attach: history older than the replay's 2 MiB, and the modes that change how
  output is drawn (insert, autowrap, origin, scroll region) when they were set before the output
  the replay holds. A terminal on the alternate screen (a full-screen program) is not reset: the
  replay is redrawn on that screen, as before.
- A browser that opens a session reads its recent output at the width it was produced at, then
  rewraps it to its own width: long lines written by a program for a wider terminal no longer
  end one word per row. The PTY host now names, in its attach reply, the terminal size before
  the attaching browser's is applied (`replay_geometry`), and the web server passes it to the
  page before the output. The field is additive: a page that does not ask for it, or a PTY host
  that does not give it, behaves as before. The PTY host part takes effect after the PTY host
  restarts; the scrollback is rewrapped at the last size only, not per segment of output.
