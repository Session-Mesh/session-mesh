---
kind: changed
---
- **`mesh-open` is now a native executable.** Linux and macOS releases include the command. For a
  source checkout, run `scripts/bootstrap.sh --install-only` in the selected opam switch, then
  rerun the installer. Connection and timeout errors now use the native HTTP client's diagnostics.
  See [Upgrading a source install](docs/operations.md#upgrading-a-source-install).
