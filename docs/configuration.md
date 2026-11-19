# Configuring session-mesh

This page lists the command-line tools that the installer puts on your `PATH` and the environment
variables the web server reads. The installation itself is in [install.md](install.md); upgrades,
token replacement, a second mesh for testing and the other operations are in
[operations.md](operations.md).

## Command-line tools

The installer links these into `~/.local/bin`.

| Command | What it does |
|---|---|
| `mesh-open FILE` | Shows a local document in the interface (a web page is refused: open it in a browser). From a mesh session it opens next to that session's pane; `--watch` reloads it when the file changes. |
| `mesh-attach [NAME]` | Opens a new mesh session in the current terminal, or attaches to `NAME`; `-l` lists sessions. Closing the window only detaches. |
| `mesh-rename NAME` | Renames the current mesh session; `--folder FOLDER` files it, `-s SESSION` targets another one, `--clear` restores the default name. |
| `mesh-logout-all` | Logs out every browser at once. The token and the sessions are unchanged. A native program, not a Python script: a release links its own; a source install links the one `scripts/bootstrap.sh` installs in the opam switch, and when that switch lacks it, the installer warns and makes no link (a link of your own is left as it is). Build it with `MESH_OPAM_SWITCH=<switch> bash scripts/bootstrap.sh --install-only`, then run `MESH_OPAM_SWITCH=<switch> ./install.sh` again with the same switch. |

## Environment variables

The web server reads its settings from its environment. Set them with
`systemctl --user edit session-mesh` (lines `Environment=NAME=value` under `[Service]`), then
`systemctl --user restart session-mesh`; restarting the web server does not end sessions. On macOS,
see [macOS](operations.md#macos).

| Variable | Default | Effect |
|---|---|---|
| `MESH_PORT` | `7690` | Listen port. Set by the installer from its own environment; a rerun without it keeps the installed port. Sessions started by the web server receive it; another port needs extra steps for the command-line tools and `mesh-attach` sessions: see [Using another port than 7690](operations.md#using-another-port-than-7690). |
| `MESH_HOST` | `127.0.0.1` | Listen address. Anything other than `127.0.0.0/8`, `::1` or `localhost` is refused at startup. |
| `MESH_ALLOW_NON_LOOPBACK` | unset | `1` allows a non-loopback `MESH_HOST`, with a warning. The token and cookie then travel in clear unless a TLS proxy fronts every request. |
| `MESH_TRUST_PROXY` | unset | `1` declares a reverse proxy on this machine that sets `Host` to the server's own address (nginx's default): its `X-Forwarded-Host` and `X-Forwarded-Proto` are then believed, from local connections only, so the proxy must set both itself, overwriting any value the client sent (nginx: `proxy_set_header X-Forwarded-Host $host;` and `proxy_set_header X-Forwarded-Proto $scheme;`), never pass them through. Not needed with `--tailscale`, nor with the [Caddy setup](operations.md#https-on-a-vpn-address-with-a-reverse-proxy), which keeps `Host`. Without it behind a proxy that rewrites `Host`, the page loads but every action is refused (403). |
| `MESH_CONF_DIR` | `~/.config/session-mesh` | Token, cookie generation, session snapshot, names and folders, projects. Absolute path. The command-line tools read the token there, so when you move it, export the same value in the shell where you run them outside a mesh session. |
| `MESH_CACHE_DIR` | `~/.cache/session-mesh` | Uploads and the history index, including the full-text database. Absolute path. |
| `MESH_OPAM_SWITCH` | written by the installer | Switch where agents find `mesh-board-mcp` in a source install. Unset, the server uses `OPAM_SWITCH_PREFIX`, then `_opam/` in the checkout ([Native PTY host](install.md#native-pty-host)). |
| `MESH_PUSH` | on | `0` turns push notifications off. |
| `MESH_ANSWER_BUTTONS` | off | `1` adds answer buttons to detailed notifications ([Answer buttons in notifications](operations.md#answer-buttons-in-notifications)). |
| `MESH_LAUNCH_SETTINGS` | unset | Absolute path of a JSON file that restricts the folders where sessions can be created and the agents offered ([Restricting folders and agents](operations.md#restricting-folders-and-agents)). |
| `MESH_UPDATE_CHECK` | on | Read by the PTY host, not the web server, as the default of the file `update-notice` of the configuration directory, which overrides it and applies without a restart (`check=0`, `notice=minor`...: [Update notice](operations.md#update-notice)). `0` turns the update notice off: no request to GitHub, no banner, no log line ([Update notice](operations.md#update-notice)). |
| `MESH_UPDATE_NOTICE` | `all` | Read by the PTY host, as the default of the `update-notice` file (`notice=` line). Which newer releases the update notice announces: `all`, `minor`, `major`, `security` or `none` (no request). A security release is announced at every level but `none`; an unknown value counts as `all`. |
| `MESH_UPDATE_DEBUG` | unset | Read by the PTY host. `1` logs why an update check failed. |
| `MESH_CODEX_QUEUE_WAKE` | off | `1` lets the mesh wake a Codex session with `codex queue` when agent mail arrives ([Waking Codex with codex queue](operations.md#waking-codex-with-codex-queue)). |

`WL_HOME` is not a server setting, but the Projects view reads the project tracker with the web
server's `WL_HOME` (unset: `~/worklog-data`, else `~/worklog`). Sessions do not receive the web
server's value: when you set it, give the same absolute path to the web server here and to the
sessions in your login shell's startup file
([The Projects view and the project tracker](features.md#the-projects-view-and-the-project-tracker)).

The installer itself reads `MESH_PYTHON`, `MESH_OPAM_SWITCH`, `MESH_PORT` and
`MESH_REQUIRE_ATTESTATION`; see [install.md](install.md).

## The source code link

If you run a modified version for other people over a network, the AGPL requires you to offer them
its source code. The "Source code" link at the bottom of the sidebar is there for that: change its
`href` (the `#source-link` element in `static/index.html`) to the address of your modified source.
