# Bounded TSX compiler for demos

This component compiles a TSX source read on `stdin` into a self-contained JavaScript bundle on `stdout`, without running the guest code. No route, panel or demo engine of the local mode calls it. It provides no `@self` authentication, no CAS storage, no E2EE encryption and no isolation of the bundle when it runs.

On a Linux host with Node 22.13+ or 24+, `/usr/bin/bwrap` (package `bubblewrap`), `timeout` and `prlimit`, install the pinned dependencies in this directory with `npm ci --ignore-scripts`, then run from the repository root:

```sh
scripts/compile-demo-tsx.sh < demo-compiler/fixture.tsx > /tmp/mesh-demo-example.js
```

The compiler runs only on Linux. On any other system, macOS included, the launcher exits 78 and says that the demo compiler is not available there; it never runs the compiler outside bubblewrap. A macOS bundle therefore carries the compiler but cannot run it. Since nothing in the local mode calls it, no feature is lost there today.

The launcher runs the Node named by `MESH_NODE` (an absolute path), otherwise `node` from the caller's `PATH`, resolved to its real file. It fails closed if the package is not installed, if Node or `bwrap` is missing, or if the confinement does not start; on Ubuntu 24.04, see [docs/development.md](../docs/development.md#bubblewrap-and-ubuntu-2404) for the AppArmor restriction. It exposes to the child process, read-only, only `/usr`, the system libraries, the Node executable file, this directory and the minimal pseudo-filesystems; it creates separate user, process and network namespaces, empties the environment and bounds the input (64 KiB), the output (128 KiB), the Node heap (128 MiB), the virtual address space (1 GiB), the CPU time per process (4 s) and the wall-clock time (6 s). Any import, even a local one, is refused by the compiler. Parse errors do not copy the source to `stderr`.

The caller must check for exit status zero before accepting the bundle and
discard any partial output on failure, signal or timeout.

The guest source stores in `globalThis.__mesh_result` either a declarative view
or a function `(timeMs) => view` for the animated probe. The bundle reads the
time only through the integer `globalThis.__mesh_time_ms` that the host injects
into the QuickJS interpreter running it, never through a host function or a
network API. The output remains a JSON string to validate before any rendering;
the compiler does not validate the view tree itself and is not the execution
boundary.

These bounds and the local test do **not** prove a physical memory limit for the whole process group, the absence of a `bubblewrap` escape, or the behaviour on other kernels or architectures. A cgroup limit, validation of the immutable installation and an independent review are still required before compiling agent code. The result must then be treated as an untrusted artifact and run only behind a reviewed execution boundary.

`npm test` compares the launcher with the pinned compiler and checks that HTTP and local imports, oversized input, invalid UTF-8, unexpected arguments, a hostile `NODE_OPTIONS` and an invalid `MESH_NODE` are refused, and, with a stand-in `uname` that answers `Darwin`, that the launcher refuses off Linux. On a system other than Linux it only checks that the pinned esbuild compiles the fixture and that the launcher refuses; the bundle build runs it on every platform. It ignores one known line on `stderr`, the `--expose_wasm` warning that Node 22 prints with `--jitless`, and nothing else. These tests cover the compiler's confinement, not the rendering of the bundle.
