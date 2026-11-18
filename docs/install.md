# Installing session-mesh

This page installs session-mesh on Linux from a release, the default path, then covers the other
ways in (an extracted bundle, a git clone), reaching the interface from other devices, and
uninstalling. macOS is covered in [macOS](operations.md#macos). Once it runs, upgrades,
restores and the other maintenance tasks are in [operations.md](operations.md), and the settings in
[configuration.md](configuration.md).

## Contents

- [Requirements](#requirements)
- [Install a release](#install-a-release)
- [After the install](#after-the-install)
- [Other ways to install](#other-ways-to-install)
- [Native PTY host](#native-pty-host)
- [Reaching it from other devices](#reaching-it-from-other-devices)
- [Uninstall](#uninstall)

## Requirements

- On macOS, the requirements and the installation are in [macOS](operations.md#macos); the rest of
  this page is for Linux.
- Linux with a systemd user instance (systemd 242 or later: the units use the `:` prefix of
  `ExecStart=`, added in systemd 242). Run the installer as your own user in a login session: not
  with `sudo` or as root, and not in a container or WSL without systemd. It stops with
  "session-mesh needs a systemd user session" otherwise.
- A release install needs no Python, Node or compiler: the release bundle brings them. Its Linux
  bundles need glibc 2.28 or later (RHEL 8, Debian 10, Ubuntu 18.10 or newer) on x86_64 or arm64;
  its macOS bundle needs macOS 13.5 or later on Apple silicon. On an older system, or
  with musl, the release installer installs the release's native programs and code instead, run
  with your Python (as for a source install, below); a Mac older than macOS 13.0 installs from a
  clone, as does an Intel Mac.
- For a source install, and for a release installed from its native programs: Python 3.10 or later
  with `aiohttp` (3.x). CI tests Python 3.12; the sources also compile with Python 3.10 and 3.11,
  but the suite does not run on them.
- `curl`, used by the installer to download a release and to check that the service answers; `git`
  for a source install from a clone.
- `~/.local/bin` on your `PATH`, where the installer links the command-line tools. The installer
  creates that folder when it is missing. On Debian and Ubuntu, `~/.profile` adds it to the `PATH`
  only if it existed when you logged in: log in again after the first install, or run
  `export PATH="$HOME/.local/bin:$PATH"` in the current shell.

Packages for a source install, as printed by `install.sh` when something is missing (add `git` if
you do not have it; on a fresh Debian or Ubuntu image, run `sudo apt update` first):

| Distribution | Command |
|---|---|
| Debian, Ubuntu | `sudo apt install python3 python3-aiohttp curl` |
| Fedora | `sudo dnf install python3 python3-aiohttp curl` |
| Arch | `sudo pacman -S python python-aiohttp curl` |

Optional:

- `cryptography` for Python (`python3-cryptography`, or `python-cryptography` on Arch) enables push
  notifications in a source install (a release bundle includes it). Without it the 🔔 button says
  they are unavailable and everything else works.
- `rg` (ripgrep) speeds up the literal part of the History full-text search; without it the server
  uses `grep -r`. The ranked part comes from the `mesh-history` full-text database, which a release
  brings and a source install builds ([Native PTY host](#native-pty-host)); see
  [Conversation history](features.md#conversation-history).
- `xdg-open` lets the interface open a clicked web URL in your desktop browser.
- `claude`, `codex`, `pi`, `opencode`, `gemini`, `agy`, `copilot` or `vibe` on your `PATH` to start
  those agents. What each one gets in the mesh, and its own prerequisites (Antigravity's plugin,
  Pi 1.3 or later), are in [agents.md](agents.md).
- `gh`, the GitHub CLI, logged in (`gh auth login`): when it is on your `PATH`, the installer checks
  the build attestation of every file it downloads ([Install a release](#install-a-release)).
- opam, only for a source install: `scripts/bootstrap.sh` creates an OCaml 5.3 switch and builds
  the native PTY host and the other native programs in it ([Native PTY host](#native-pty-host)).
- Tailscale, to reach the interface from your other devices ([Tailscale](#tailscale)).

## Install a release

Download the release's `install.sh` and `SHA256SUMS`, check the installer, and run it. Pick the tag
on the [releases page](https://github.com/Session-Mesh/session-mesh/releases).

```sh
tag=v1.2.3   # the release you install
base="https://github.com/Session-Mesh/session-mesh/releases/download/$tag"
curl -fsSLO "$base/install.sh" -O "$base/SHA256SUMS"
sha256sum -c --ignore-missing SHA256SUMS      # macOS: shasum -a 256 -c --ignore-missing SHA256SUMS
gh attestation verify install.sh --repo Session-Mesh/session-mesh \
  --signer-workflow Session-Mesh/session-mesh/.github/workflows/release.yml \
  --source-ref "refs/tags/$tag"
bash install.sh
```

The checksum detects a corrupted download; the attestation shows that the file was built by the
release workflow of the repository from that tag. Without the [`gh` CLI](https://cli.github.com/),
skip that line ([what you are trusting](operations.md#prebuilt-binaries)).

Each release's `install.sh` carries that release's tag and the SHA-256 of every other file of the
release except `SHA256SUMS`. It downloads the bundle of your platform for that tag only
(`mesh-linux-x86_64.tar.gz`, `mesh-linux-arm64.tar.gz` or `mesh-macos-arm64.tar.gz`: the code, its
own Python and Node runtimes with their locked dependencies, and the five native programs
`mesh-ptyhost`, `mesh-board-mcp`, `mesh-read`, `mesh-platform` and `mesh-history`), checks it
against that hash, and extracts it into `~/.local/share/session-mesh/releases/<tag>/`. An archive
that does not match, or whose native programs do not match its own manifest, stops the install, and
nothing of the release is kept. The installer then points `~/.local/share/session-mesh/current` at
that release. A release also publishes the five native programs of each platform (static
executables on Linux) and the code archive: for a platform without a bundle in the release, the
installer installs those instead and runs the web server with your Python
([Installing a release](operations.md#installing-a-release)).

It writes two systemd user units in `~/.config/systemd/user/`, `session-mesh.service` (the web
server) and `session-mesh-pty.service` (the PTY host that owns the sessions), both running from
`current/`. It enables and starts them, and links `mesh-open`, `mesh-attach`, `mesh-rename` and
`mesh-logout-all` into `~/.local/bin` ([command-line tools](configuration.md#command-line-tools)).
On macOS it writes two launchd jobs instead ([macOS](operations.md#macos)). The web server and the
commands run with the bundle's own Python, never the machine's; your configuration and data stay in
`~/.config/session-mesh` and `~/.cache/session-mesh`, never inside a release directory.

When it finishes, it prints:

```text
  URL      : http://127.0.0.1:7690
  token    : cat ~/.config/session-mesh/token
  logs     : journalctl --user -u session-mesh -f
  uninstall: ~/.local/share/session-mesh/current/install.sh --uninstall
  release  : v0.1.0 (upgrade: .../current/install.sh --upgrade; back: .../current/install.sh --rollback)
```

On macOS the block also gives the runtime directory and the command that restarts the web server,
and the logs are in `~/Library/Logs/session-mesh/`.

Open the URL and paste the token. The server created that token, readable only by you, on its first
start. The browser then keeps a login cookie; it stays valid until you log out every device or
replace the token ([SECURITY.md](../SECURITY.md#what-session-mesh-defends-against)). A script can
send the same token in an `Authorization: Bearer` header instead of a cookie.

### What the checks rely on

The hashes in `install.sh` and the `SHA256SUMS` of a release come from the project's GitHub
repository, over HTTPS. They detect a corrupted download, not a release whose files were replaced
together with its `SHA256SUMS`. The attestation, checked by `gh attestation verify`, shows that a
file was built by the release workflow of `Session-Mesh/session-mesh` from the tag you install; it
does not show that the tag names a reviewed commit. Both rely on GitHub and on every credential that
can push to the repository, tokens included ([what you are trusting](operations.md#prebuilt-binaries)).

When `gh` is on your `PATH` and logged in, the installer checks the attestation of every file it
downloads and stops at the first failure; without `gh`, or with `gh` not logged in, it says once
that it did not, and gives the command. `MESH_REQUIRE_ATTESTATION=1` makes it refuse instead. A `gh`
too old to support `--source-ref` fails every check, so nothing is installed: use a recent `gh`
(tested with 2.102.1; [details](operations.md#upgrading-a-release-install)).

## After the install

**Upgrade** with `~/.local/share/session-mesh/current/install.sh --upgrade`: it installs the latest
published release beside the current one, switches `current`, and restarts the web server. It never
restarts the PTY host, because that ends every session: it says whether `mesh-ptyhost` changed and
gives the command. `--rollback` goes back to the previous release. Both are described in
[Upgrading a release install](operations.md#upgrading-a-release-install).

**Keep it running after logout.** User services stop when your last session ends. The installer
warns when lingering is off but does not change it; to enable it, run:

```sh
sudo loginctl enable-linger "$USER"
```

On a Mac without a graphical login, which is the usual case for a Mac used over SSH, the equivalent
is `bash install.sh --at-boot`: it lists its `sudo` commands, asks for one confirmation, and installs
the two jobs as daemons that start at boot with nobody logged in
([Running at boot on a headless Mac](operations.md#running-at-boot-on-a-headless-mac)). It has been
verified on macOS 15 across a reboot with nobody logged in.

**Run it again safely.** Re-running the installer rewrites the web unit and restarts the web server.
It starts the PTY host only when it is stopped and never restarts it, so the mesh sessions keep
running. Without `MESH_PORT`, it keeps the port of the installed web unit and says so; with a
different `MESH_PORT`, it warns that the port changes.

The installer refuses some paths, ports and unit states before changing anything; they are listed
in [Installer limits](operations.md#installer-limits).

## Other ways to install

**Offline.** `bash install.sh --assets-dir /absolute/dir` takes the release files from a directory
(the bundle of your platform, under its release name) instead of GitHub, with the same checks.

**An extracted bundle, or an earlier bundle install.** `./mesh install` in an extracted bundle
installs the services from that directory, which must then stay where it is
([binary-bundles.md](binary-bundles.md)). When the services of your account already run another
extracted bundle, for example one unpacked under `~/.local/libexec/session-mesh`, the installer
leaves them as they are and stops; rerun it with `--switch-from-bundle` to move the web service to
the new installation. The running PTY host and its sessions keep running from the old bundle until
it restarts, and the installer never deletes that bundle
([Moving from an extracted bundle](operations.md#moving-from-an-extracted-bundle)).

**From a clone.** A git checkout is the developer path, a *source install*: the units run the
checkout in place, and the native programs come from your opam switch
([Native PTY host](#native-pty-host)).

```sh
git clone https://github.com/Session-Mesh/session-mesh.git
cd session-mesh
./install.sh
```

Keep the checkout where it is, and run `./install.sh` again after moving it. A source install is
upgraded with `git pull` then `./install.sh`; `--upgrade` refuses there. Moving an account between a
release install and a source install is described in [Source installs](operations.md#source-installs).

### Python from a virtual environment

For a source install: when your distribution has no `aiohttp` package, or you prefer a venv, install
the packages in it and give the installer the interpreter with `MESH_PYTHON` (an absolute path). A
release install ignores `MESH_PYTHON` and runs the bundle's own Python. On Debian and Ubuntu,
`python3 -m venv` needs the `python3-venv` package.

```sh
python3 -m venv ~/.venvs/session-mesh
~/.venvs/session-mesh/bin/pip install 'aiohttp>=3,<4' cryptography   # cryptography: optional, push notifications
MESH_PYTHON="$HOME/.venvs/session-mesh/bin/python" ./install.sh
```

From a clone, `pip install -r requirements.txt` installs the same packages. The web unit runs that
interpreter; the PTY host is a native program and uses none. Without `MESH_PYTHON`, the installer
uses `python3` from your `PATH`.

## Native PTY host

The PTY host, which owns the terminals and so the sessions, is the native program `mesh-ptyhost`,
written in OCaml, on Linux and macOS. A release bundle brings it with the four other native
programs: the board MCP server `mesh-board-mcp` that agents use for messages, requests and the
whiteboard, `mesh-read`, `mesh-platform`, and `mesh-history`, which keeps the History full-text
database. A release install needs no OCaml.

A source install takes the host from the first of these that applies:

1. `--ptyhost /absolute/path`: exactly that file, not checked.
2. `mesh-ptyhost` on your `PATH`.
3. The `bin` directory of your opam switch (`MESH_OPAM_SWITCH`, otherwise the current switch).

A release has bundles for Linux x86-64, Linux arm64 and macOS on Apple silicon. There is none for
another architecture, such as an Intel Mac: use a source install there.

**Build.** `scripts/bootstrap.sh --install-only` installs the OCaml dependencies into the opam
switch named by `MESH_OPAM_SWITCH` (otherwise the current switch), then builds and installs
`mesh-ptyhost`, `mesh-board-mcp`, `mesh-read`, `mesh-platform` and `mesh-history` into that switch.
It needs an initialised opam (`opam init`), a C compiler, the GMP and SQLite (with FTS5) headers and
`pkg-config` (the OCaml part of
[Test tools on a fresh machine](development.md#test-tools-on-a-fresh-machine)), and no Python test
environment. SQLite 3.27 or newer is needed for accent folding in the full-text index; with an
older SQLite, `mesh-history` uses the `remove_diacritics 1` tokenizer instead.

The bootstrap reads packages from the opam repository at the commit fixed in
`scripts/release-pins.sh`, the one CI and the releases build with, whatever your own opam
repositories hold: no `opam update` is needed. It registers that commit in your opam root as the
repository `session-mesh` and selects it for its switch only; your other switches and the `default`
repository are not changed. A switch that does not exist yet is created with OCaml 5.3 from that
repository, without becoming your current switch. An existing switch must use OCaml 5.3 and already
read only that commit: the bootstrap does not change the repositories of a switch that other
projects may use, your current switch included, and stops with a message instead. Use a dedicated
switch, as below, which is created when missing. To let the bootstrap make an existing switch read
only that commit, set `MESH_OPAM_SELECT_PINNED=1`; it then prints the command that restores the
repositories the switch read before. A switch that reads only the `session-mesh` repository (one an
earlier bootstrap created or moved) is kept on later runs: when the pin has changed, the bootstrap
moves the URL of `session-mesh` to the new commit, without that variable, and prints the
`opam repository set-url` command that restores the former URL. The `session-mesh` repository
belongs to the whole opam root: moving its URL moves every switch that reads it, and two checkouts
with different pins (for example `main` and a release branch) move it back and forth on each run.
Give such checkouts their own opam root (`OPAMROOT`) or their own repository-local switch. The local
switch of the checkout (`_opam/`, as in CI) is changed without that variable. `MESH_OPAM_SWITCH` may also be the absolute directory of a local
switch. Without `MESH_OPAM_SWITCH`, the bootstrap uses your current switch and does not pick another
one, because `install.sh` and the server also look for the programs in the current switch.

```sh
MESH_OPAM_SWITCH=session-mesh bash scripts/bootstrap.sh --install-only
MESH_OPAM_SWITCH=session-mesh ./install.sh --ptyhost "$(opam var --switch=session-mesh bin)/mesh-ptyhost"
```

With `mesh-ptyhost` on your `PATH`, or `MESH_OPAM_SWITCH` naming the switch, `--ptyhost` is not
needed: `MESH_OPAM_SWITCH=session-mesh ./install.sh`.

Without `--install-only`, the bootstrap also runs the OCaml tests before installing. Some of them
drive the host through the Python test harness and need a Python with `pytest`, so that mode is for
development: `scripts/test-local.sh` prepares the Python environment and calls it
([development.md](development.md)).

**The host is chosen on the first install.** `--ptyhost` and `--from-source` only apply when no PTY
unit exists yet: with an existing `session-mesh-pty.service`, the installer refuses them rather than
replace the process that owns your sessions. The one exception is moving from a release install to
the clone ([Source installs](operations.md#source-installs)). A source install refuses a unit left by
an earlier install that runs `ptyhost.py`, with the commands to remove it; a release install
replaces such a unit itself
([Moving a source install to a release](operations.md#moving-a-source-install-to-a-release)). To
replace the host later, see [Replacing the PTY host](operations.md#replacing-the-pty-host).

**Record the opam switch.** Agents started by the mesh are given the `mesh-board-mcp` of the running
release or bundle in a release or bundle install, and otherwise the one of an opam switch
([where the native programs are found](operations.md#where-the-native-programs-are-found)). For the
switch, a source install writes `MESH_OPAM_SWITCH` into the web unit: the variable's value,
otherwise the switch that `opam switch show` names, otherwise nothing. It warns when the switch does
not hold `mesh-board-mcp`: agents then have no board MCP server. When the unit has no
`MESH_OPAM_SWITCH`, the web server falls back to the switch of its own opam environment
(`OPAM_SWITCH_PREFIX`), which a systemd unit normally lacks, and then to a local switch in the
checkout (`_opam/`). If you run `scripts/bootstrap.sh` after installing, run `./install.sh` again
with the same `MESH_OPAM_SWITCH` so the unit records it.

## Reaching it from other devices

The server always listens on loopback only. Three ways reach it from elsewhere:

- **An SSH tunnel**, for a machine without a screen: run this on your own computer, then open
  `http://127.0.0.1:7690` there.

  ```sh
  ssh -N -L 7690:127.0.0.1:7690 <machine>
  ```

- **Tailscale**: `--tailscale` publishes it on your tailnet ([Tailscale](#tailscale)).
- **Another VPN** (WireGuard, for example): a Caddy reverse proxy on the VPN address serves it over
  HTTPS while the server stays on loopback
  ([HTTPS on a VPN address with a reverse proxy](operations.md#https-on-a-vpn-address-with-a-reverse-proxy)).

### Tailscale

Install Tailscale and connect this machine to your tailnet first: follow
[Tailscale's installation page for Linux](https://tailscale.com/docs/install/linux), then run
`sudo tailscale up`.

```sh
./install.sh --tailscale
```

This publishes the service on your tailnet with `tailscale serve`: the node's HTTPS address
(`https://<machine>.<tailnet>.ts.net`) proxies to `http://127.0.0.1:7690`. The server itself still
listens only on loopback. Tailscale Funnel (public internet) is never used.

- The installer reads `tailscale serve status` before changing anything. If the node's HTTPS root
  already serves something else, or the status cannot be read, it refuses and changes nothing.
- If Tailscale refuses because you are not an operator, the installer asks on the terminal before
  running its only `sudo` command, `sudo tailscale set --operator=$USER`. Without a terminal, or
  without a "y", it stops and names the command; the service keeps running on loopback.

Anyone on your tailnet whose access rules let them reach that node gets the login page; the token is
still required. Read [SECURITY.md](../SECURITY.md#tailscale) before enabling this.

## Uninstall

```sh
~/.local/share/session-mesh/current/install.sh --uninstall   # release install
./install.sh --uninstall                                      # source install, from the clone
```

This stops and removes the web unit and, if the node's HTTPS root publishes exactly this service,
removes that `tailscale serve` publication and says so. It recognises that publication by the port
of the installed web unit, and leaves any other publication untouched. It does not stop the PTY
host, so your sessions keep running, and it leaves the installed releases in
`~/.local/share/session-mesh/releases`. The complete removal, which ends every mesh session, is in
[Complete removal](operations.md#complete-removal).
