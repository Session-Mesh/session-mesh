# Binary bundles

A bundle runs session-mesh without installing Python, Node, opam or a compiler. It is what a
release publishes for each platform, and what a release install extracts into
`~/.local/share/session-mesh/releases/<tag>/` ([install.md](install.md)). It includes the
native PTY host, the board MCP server, the read helpers, the web application and its own Python and
Node runtimes. Agent applications such as Claude, Codex or Pi remain separate installations with
their own authentication.

Most readers never handle a bundle directly: the release's `install.sh` downloads, checks and
installs it. This page is for running an extracted bundle by hand, and for building one.

## What a bundle holds

One archive `mesh-<os>-<arch>.tar.gz` holds one directory `mesh-<os>-<arch>/`:

| Path | Content |
|---|---|
| `mesh` | the launcher: `./mesh run`, `./mesh install`, `./mesh doctor` |
| `env.sh` | sourced by every entry point: sets `MESH_BIN_DIR` to `bin/` and names the bundled Python and Node by absolute path; it puts only `bin/` on `PATH`, so mesh sessions keep the user's own `python3` and `node` |
| `app/` | the code of the built commit (no tests, no OCaml sources), with `install.sh` |
| `bin/` | wrappers (`mesh-python`, `mesh-ptyhost`, `mesh-attach`, `mesh-open`, ...) and the native `mesh-board-mcp`, `mesh-read`, `mesh-platform`, `mesh-history`, `mesh-logout-all` |
| `libexec/` | the native PTY host `mesh-ptyhost`, which `bin/mesh-ptyhost` executes; with the optional Roster CLIs, `mesh-roster-roadmap` and `mesh-roster-pipeline`, which run them with the bundled Node |
| `runtime/` | CPython with the locked dependencies, and Node |
| `lib/` | the shared libraries of the native programs that the system does not provide |
| `licenses/` | `THIRD-PARTY.md`, the index of every embedded component with its version, licence and licence text; `SOURCE`, the repository and revision of the corresponding source, and the upstream archives (with their SHA-256) of the bundled CPython runtime and of the libraries its build links; the project's licence and notice; and the texts not kept elsewhere in the bundle: `python/` (CPython and the libraries it links), `ocaml/` (the opam packages linked into the native programs), `sqlite/` (the SQLite compiled into `mesh-history`), `go/` (the Go runtime in esbuild), `crates/` (the Rust crates of the `cryptography` wheel that are not under Apache-2.0), `lib/<library>/` (each library copied into `lib/`) |
| `bundle.json` | the source revision, the runtime versions and the SHA-256 of the six native programs |

The installer checks a bundle against its `bundle.json` before it uses it: a bundle whose native
programs do not match is refused.

## Run an extracted bundle

Use an archive built for your operating system and architecture; a Linux archive does not run on
macOS. A release publishes `mesh-linux-x86_64.tar.gz` and `mesh-linux-arm64.tar.gz`, built in
the `manylinux_2_28` image (AlmaLinux 8): they need glibc 2.28 or newer and do not run on musl
(Alpine); and, when its build passed, `mesh-macos-arm64.tar.gz`, which needs macOS 13.5 or newer
(the bundled Node 24 is built for it). Check the archive against the release's `SHA256SUMS`
(and its attestation, [Prebuilt binaries](operations.md#prebuilt-binaries)) before extracting it
into a permanent directory owned by your account:

```sh
sha256sum -c --ignore-missing SHA256SUMS
tar -xzf mesh-linux-x86_64.tar.gz
cd mesh-linux-x86_64
./mesh doctor
./mesh run
```

`run` keeps session-mesh in the foreground; stop it with Ctrl-C. `MESH_CONF_DIR`,
`MESH_CACHE_DIR`, `MESH_RUNTIME_DIR` and `MESH_PORT` select an isolated foreground instance.

To install the user services from that directory instead:

```sh
./mesh install
```

This is a *bundle install* ([Source installs](operations.md#source-installs)): `./mesh install`
runs the bundle's `app/install.sh`, the same installer as a release, and the units run the
bundle's Python and programs from where you extracted it. Do not delete or move that directory
while a service runs from it. A release install is usually the better choice: it checks the
download itself, keeps the previous release for `--rollback`, and upgrades with `--upgrade`.
Inside an installed release (`~/.local/share/session-mesh/current`), `./mesh install` runs that
release's own `install.sh`.

The installer writes systemd user units on Linux and launchd jobs on macOS, and starts the web
interface on `http://127.0.0.1:7690`; `--tailscale` publishes it on your tailnet. It starts a
stopped PTY host but never restarts a running one, which would end its sessions. Existing state
stays in `~/.config/session-mesh`: the token and the saved sessions are kept. When your account's
services already run another extracted bundle, the installer leaves them as they are unless you
pass `--switch-from-bundle`, and it never deletes the other bundle ([Moving from an extracted
bundle](operations.md#moving-from-an-extracted-bundle)).

The bundle gives agents its own board MCP server and hooks through `MESH_BIN_DIR`, rather than an
opam switch. A newly started agent gets its invocation-specific MCP entry and session credential;
already running agents keep the configuration they had at launch and need to be resumed to get a
new one.

## Build and qualify an archive

The release workflow (`.github/workflows/release.yml`) builds every bundle on its own platform's
runner, the macOS arm64 one included, on every run. To build one by hand, run
on the target platform with uv, curl, tar, Git, npm and the compiled native executables available.
Linux builds also need `patchelf`; macOS builds use the system `otool`, `install_name_tool` and
`codesign`. The third-party notices also need `zstd`, and `opam` with the switch the native
programs were built in (`MESH_OPAM_SWITCH`, else the current switch): dune's link rules name the
opam packages linked into each program, and the build copies each package's licence text from the
switch, or from its source (`opam source`) when the switch has none. These are builder
requirements, not end-user requirements. The script downloads a
standalone CPython runtime and an official Node archive, which must match the SHA-256 pinned for
that version and platform in `scripts/bundle/node.sha256`: a version without a pin, or an archive
that differs from it, stops the build. To move to another Node version, add its archives' SHA-256
lines there, taken from the release's signed `SHASUMS256.txt.asc`. The licence texts of the bundled
CPython come from python-build-standalone's "full" archive of the same release and platform (its
`PYTHON.json` and `licenses/`), whose SHA-256 is pinned in `scripts/bundle/python-licenses.sha256`
in the same way. The component, version, licence and source archives of each of those texts come
from `scripts/bundle/python-build-standalone.json`, transcribed from that release's
`pythonbuild/downloads.py`; a release or a text missing from it stops the build. The Rust crates of
the `cryptography` wheel that Apache-2.0 does not cover ship the texts of their crates.io archives,
whose SHA-256 is pinned in `scripts/bundle/crates.sha256`. The build also stops on a component
without a licence text, on a licence text that is a JSON document (a bill of materials), and on a
licence outside the allow-list of `scripts/bundle/licence-policy.mjs`, unless a reviewed exception
there names that component with its reason. A reviewed exception pins the label the component must
carry and the SHA-256 of its licence texts, and its version where one was reviewed; any difference
stops the build. The GCC runtime libraries, whose texts come from the build system's package, are
checked by content instead, and the vendored web libraries by running `tools/check-third-party.mjs`
on `app/`. The python-build-standalone recipe (MPL-2.0), whose patches are compiled into the
runtime, ships the `LICENSE` of its pinned archive. Python dependencies are pinned with hashes in
`scripts/bundle/requirements.lock` and installed from binary wheels; pip, ensurepip, IDLE, tkinter
and the Tcl/Tk scripts are then removed from the runtime, which does not use them, and
`licenses/THIRD-PARTY.md` and `licenses/SOURCE` state those changes to the CPython distribution.
Updating Node, the python-build-standalone release or the Roster distribution therefore means
reviewing the new texts and updating their pins in `scripts/bundle/licence-policy.mjs`.
`licenses/SOURCE` names `MESH_BUNDLE_SOURCE_URL`, else, in a GitHub Actions run, the repository
being built. Nothing is fetched when an end user starts the extracted bundle.

```sh
bash scripts/build-bundle.sh --output /absolute/artifacts \
  --native-bin /absolute/native/bin
bash scripts/smoke-bundle.sh /absolute/artifacts/mesh-linux-x86_64.tar.gz
```

The native directory must contain `mesh-ptyhost`, `mesh-board-mcp`, `mesh-read`, `mesh-platform`,
`mesh-history` and `mesh-logout-all` built from the intended source revision (`scripts/bootstrap.sh --install-only`
installs them into an opam switch; `opam var bin` names its directory). Release builds set
`MESH_SQLITE_PREFIX` to a directory dedicated to the pinned SQLite that `mesh-history` carries
(`scripts/build-sqlite.sh` refuses a non-empty directory it did not create, and never deletes
anything else); `scripts/smoke-bundle.sh` runs the History probe on the extracted `bin/mesh-history`
and, on Linux, fails if it needs a `libsqlite3` shared library. On Linux the build copies
the non-system shared libraries they and Node need into `lib/` and rejects unresolved ones; it also
copies the licence of each of those libraries from the package that installed it
(`/usr/share/doc/<package>/copyright` on Debian and Ubuntu, `/usr/share/licenses/<package>/` on
Arch, the licence files the RPM package declares, or those of a package built from the same source
RPM, on AlmaLinux) into `licenses/lib/`, and stops when a copied library has none. On macOS it
copies nothing: every program of the bundle may load system libraries only (`/usr/lib`,
`/System/Library`), and any other library, a Homebrew one included, stops the build. On Debian and Ubuntu it also
copies the texts of `/usr/share/common-licenses/` that a copyright file names instead of including
(the GPL and LGPL packages do this), and records the package's version and the source package
that offers its corresponding source (`PACKAGE`, `SOURCE`); on Arch, the texts of
`/usr/share/licenses/spdx/` for the licences the package's metadata names. Build Linux bundles
against the supported glibc, 2.28: a binary linked on a newer distribution does not run on an older
glibc merely because its other libraries were copied. The release does this with
`scripts/release-build-bundle-linux.sh` in the `manylinux_2_28` image (AlmaLinux 8), then checks
every ELF file with `scripts/release-check-glibc.sh`. That build passes `--skip-compiler-test`,
since bubblewrap cannot run in the container, and runs the demo compiler's test on the extracted
bundle outside it.

The archive includes the TSX compiler's pinned esbuild package and platform binary. Its Linux
sandbox still needs the operating system's bubblewrap, `prlimit` and `timeout`; this package does
not replace that sandbox with an unconfined compiler. That optional compilation path is not
supported on macOS: there the launcher refuses with exit 78, and the build checks only that the
bundled esbuild compiles and that the launcher refuses ([demo-compiler/README.md](../demo-compiler/README.md)). Rendering existing demos and ordinary sessions do not depend on this compiler.

`--roster-dir /absolute/public-roster-distribution` optionally includes a public Roster CLI
distribution, preserving its `scripts` and `schema` closure; the release workflow includes the
public Roster at a fixed commit. The project observation runs each CLI through
`libexec/mesh-roster-roadmap` or `libexec/mesh-roster-pipeline`, which start it with the bundled
Node: the CLIs begin with `#!/usr/bin/env node`, and the bundled Node is not on the `PATH` the PTY
host and its sessions use. The smoke test puts a `node` that always fails first on `PATH`, runs
the wrapper, and checks the Roster data through the native observation API. Only use a distributable public tree; never point
this option at a project's private harness or its credentials. Without it, Roster observation
requires a separately configured CLI, while Sessions and Git observation remain available. This
archive does not install agent CLIs or a harness into user projects.

The smoke test extracts the archive into another path and runs it with a temporary account and no
development opam or Python environment. It checks a real native session, HTTP access and the MCP
protocol. An archive is releasable only after its target platform's smoke test has passed; that is
the rule the release workflow applies before it publishes a platform. The macOS bundle is also
checked file by file (`scripts/release-check-macos.sh bundle`): every Mach-O file must be built for
macOS 13.5 or older and load no library by an absolute path outside `/usr/lib` and
`/System/Library`. On macOS, the ad-hoc signature the build applies is not an Apple notarization or
a Developer ID signature.
