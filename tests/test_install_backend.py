# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Actual installer, copied into owned disposable paths; no real manager/network."""

from pathlib import Path
import shutil
import subprocess

import pytest


def _install(tmp_path, arguments=(), *, loaded=False, active=False, query_ok=True,
             native=True, local_kind=None, endpoint=False, binary_name="mesh-ptyhost",
             vendor_only=False, needs_reload="no", missing_template=False,
             manager_state=None, binary_fault=None, pty_text=None, dropin_text=None):
    root = Path(__file__).resolve().parents[1]
    checkout = tmp_path / "checkout"
    shutil.copytree(root / "systemd", checkout / "systemd")
    shutil.copy2(root / "install.sh", checkout / "install.sh")
    (checkout / "scripts").mkdir()
    for name in ("install-checkout.sh", "install-common.sh", "install-release.sh", "install-linux.sh",
                 "install-linux-units.sh"):
        shutil.copy2(root / "scripts" / name, checkout / "scripts" / name)
    if missing_template:
        (checkout / "systemd/session-mesh-pty.service.in").unlink()
    for command in ("mesh-open", "mesh-attach", "mesh-rename"):
        (checkout / "bin").mkdir(exist_ok=True)
        (checkout / "bin" / command).touch()
    home = tmp_path / "home"
    home.mkdir(mode=0o700)
    units = home / ".config/systemd/user"
    units.mkdir(parents=True)
    pty = units / "session-mesh-pty.service"
    if local_kind == "dangling":
        pty.symlink_to(tmp_path / "absent")
    elif local_kind == "mask":
        pty.symlink_to("/dev/null")
    elif local_kind == "dropin":
        (units / "session-mesh-pty.service.d").mkdir()
        (units / "session-mesh-pty.service.d/foreign.conf").write_text(dropin_text or "foreign sentinel\n")
        if pty_text:
            pty.write_text(pty_text)
    elif (loaded and not vendor_only) or local_kind == "file":
        pty.write_text(pty_text or "foreign PTY config\n")
    web = units / "session-mesh.service"
    web.write_text("web sentinel\n")
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    if endpoint:
        (runtime / "session-mesh").mkdir()
        (runtime / "session-mesh/ptyhost.sock").touch()
    commands = tmp_path / "bin"
    commands.mkdir()
    effects = tmp_path / "effects"
    effects.touch()
    unexpected = tmp_path / "unexpected"
    unexpected.touch()
    startup = tmp_path / "bash-env"
    startup.write_text('command_not_found_handle() { printf "unknown-command\\n" >> "$UNEXPECTED"; return 97; }\n')
    failure_trap = 'trap \'code=$?; if ((code == 97)); then printf "unexpected-call\\n" >> "$UNEXPECTED"; fi; exit "$code"\' EXIT\n'
    observation = "\n".join((
        f"LoadState={'loaded' if loaded else 'not-found'}",
        f"ActiveState={manager_state[0] if manager_state else 'active' if active else 'inactive'}",
        f"SubState={manager_state[1] if manager_state else 'running' if active else 'dead'}",
        f"FragmentPath={str(pty) if loaded and pty.is_file() else '/vendor/session-mesh-pty.service' if loaded else ''}",
        f"DropInPaths={str(units / 'session-mesh-pty.service.d/foreign.conf') if loaded and local_kind == 'dropin' else '/vendor/dropin.conf' if loaded else ''}",
        f"NeedDaemonReload={needs_reload}",
    ))
    stubs = {
        "systemctl": 'if [[ "$*" == "--user show session-mesh-pty.service --property=LoadState,ActiveState,SubState,FragmentPath,DropInPaths,NeedDaemonReload" ]]; then printf "%s\\n" "$OBSERVATION"; exit "$QUERY_EXIT"; fi\n'
                     # The web unit is observed too (is it another bundle's?): a sentinel file, not loaded.
                     'if [[ "$*" == "--user show session-mesh.service --property=LoadState,ActiveState,SubState,FragmentPath,DropInPaths,NeedDaemonReload" ]]; then printf "%s\\n" LoadState=not-found ActiveState=inactive SubState=dead FragmentPath= DropInPaths= NeedDaemonReload=no; exit 0; fi\n'
                     'case "$*" in "--user daemon-reload"|"--user enable session-mesh-pty.service session-mesh.service"|"--user start session-mesh-pty.service"|"--user restart session-mesh.service"|"--user disable --now session-mesh.service") ;; *) exit 97;; esac\n'
                     'printf "%s\\n" "$*" >> "$EFFECTS"\n',
        "python3": 'if [[ $2 == "import sys;"* ]]; then echo 3.12; exit 0; fi\n'
                   'if [[ $2 == "import aiohttp" || $2 == "import cryptography" ]]; then exit 0; fi\n'
                   'exit 97\n',
        "tailscale": 'case "$*" in "serve status --json") printf "%s" "$SERVE_STATUS"; exit 0;; "serve --https=443 off") ;; *) exit 97;; esac\n'
                     'printf "%s\\n" "tailscale $*" >> "$EFFECTS"\n',
        "curl": '[[ "$*" == "--noproxy * -fs -o /dev/null http://127.0.0.1:7690/login" ]] || exit 97\n',
        "loginctl": '[[ "$*" == "show-user fixture -p Linger" ]] || exit 97\nprintf "Linger=yes\\n"\n',
        "sudo": 'exit 97\n',
    }
    for name, body in stubs.items():
        path = commands / name
        path.write_text("#!/bin/bash\nset -eu\n" + failure_trap + body)
        path.chmod(0o700)
    for name in ("ssh", "wget", "nc", "busctl", "systemd-run", "journalctl",
                 "kill", "pkill", "killall", "getent", "id", "whoami"):
        path = commands / name
        path.write_text("#!/bin/bash\n" + failure_trap + "exit 97\n")
        path.chmod(0o700)
    # Only inspected filesystem/read-only tools are reachable. No ambient PATH
    # fallback can reach an unknown manager, network or account command.
    for name in ("dirname", "readlink", "mkdir", "rm", "sed", "seq", "sleep",
                 "grep", "cat", "ln", "mktemp"):
        path = commands / name
        guard = ""
        if name == "rm":
            guard = 'for arg in "$@"; do [[ $arg == -* || $arg == "$HOME/.config/systemd/user/session-mesh.service" || $arg == "$TMPDIR"/mesh-serve.* ]] || exit 97; done\n'
        elif name == "mkdir":
            guard = 'for arg in "$@"; do [[ $arg == -* || $arg == "$HOME"/* ]] || exit 97; done\n'
        elif name == "ln":
            guard = '[[ $# == 3 && $1 == -sfn && $2 == "$TEST_CHECKOUT"/bin/* && $3 == "$HOME"/.local/bin/* ]] || exit 97\n'
        elif name == "mktemp":
            guard = '[[ $# == 1 && $1 == "$TMPDIR/mesh-serve.XXXXXXXX" ]] || exit 97\n'
        path.write_text("#!/bin/bash\nset -eu\n" + failure_trap + guard + f'exec /usr/bin/{name} "$@"\n')
        path.chmod(0o700)
    binary = commands / binary_name
    if native:
        binary.write_text("#!/bin/bash\nexit 97\n")
        binary.chmod(0o700)
        if binary_fault == "nonexec":
            binary.chmod(0o600)
        elif binary_fault == "directory":
            binary.unlink()
            binary.mkdir()
        elif binary_fault == "symlink":
            actual = commands / "actual-native"
            binary.rename(actual)
            binary.symlink_to(actual)
    arguments = tuple(str(binary) if item == "BINARY" else item for item in arguments)
    result = subprocess.run(
        ["/bin/bash", str(checkout / "install.sh"), *arguments],
        env={"HOME": str(home), "USER": "fixture", "PATH": str(commands),
             "TMPDIR": str(tmp_path), "XDG_RUNTIME_DIR": str(runtime), "LC_ALL": "C",
             "OBSERVATION": observation, "QUERY_EXIT": "0" if query_ok else "1",
             "EFFECTS": str(effects), "TEST_CHECKOUT": str(checkout),
             "UNEXPECTED": str(unexpected), "BASH_ENV": str(startup),
             "SERVE_STATUS": '{"TCP":{"443":{"HTTPS":true}},"Web":{"node.example:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7690"}}}}}'},
        stdin=subprocess.DEVNULL, capture_output=True, timeout=5,
    )
    assert unexpected.read_text() == "", "HARNESS_EXECUTION: unexpected call"
    assert result.returncode not in (97, 126, 127) and result.returncode >= 0
    return result, pty, web, effects.read_text(), binary


# The PTY host is the native mesh-ptyhost: from --ptyhost, else from PATH.
EXPLICIT = ("--ptyhost", "BINARY")


def test_native_host_found_on_path_is_the_default(tmp_path):
    result, pty, _, effects, binary = _install(tmp_path)
    assert result.returncode == 0, result.stderr
    assert f'ExecStart=:"{binary}"' in pty.read_text()
    assert "--user start session-mesh-pty.service" in effects
    assert "--user restart session-mesh.service" in effects
    assert "restart session-mesh-pty" not in effects
    assert not any(word in effects for word in ("stop ", "kill ", "disable "))


def test_explicit_path_selects_the_native_host(tmp_path):
    result, pty, _, _, binary = _install(tmp_path, EXPLICIT, binary_name="chosen-host")
    assert result.returncode == 0, result.stderr
    assert f'ExecStart=:"{binary}"' in pty.read_text()


def test_missing_host_refuses_with_both_ways_to_get_it(tmp_path):
    result, pty, web, effects, _ = _install(tmp_path, native=False)
    assert result.returncode == 1
    assert b"scripts/bootstrap.sh" in result.stderr
    assert b"--from-source" in result.stderr and b"--ptyhost /absolute/path" in result.stderr
    assert not pty.exists()
    assert web.read_text() == "web sentinel\n"
    assert effects == ""


@pytest.mark.parametrize("started", [False, True])
def test_a_unit_that_runs_the_python_host_is_refused_with_the_way_to_switch(tmp_path, started):
    unit = 'ExecStart=:"/usr/bin/python3" "/old/checkout/ptyhost.py"\n'
    result, pty, web, effects, _ = _install(tmp_path, loaded=True, active=started, pty_text=unit)
    assert result.returncode == 1
    assert b"Python PTY host" in result.stderr
    assert b"systemctl --user disable --now session-mesh-pty.service" in result.stderr
    assert b"daemon-reload" in result.stderr
    assert pty.read_text() == unit
    assert web.read_text() == "web sentinel\n"
    assert effects == ""


PYTHON_UNIT = 'ExecStart=:"/usr/bin/python3" "/old/checkout/ptyhost.py"\n'
NATIVE_COMMAND = 'ExecStart=:"/opt/session-mesh/mesh-ptyhost"\n'


@pytest.mark.parametrize("dropin", [
    "[Service]\nExecStart=\n" + NATIVE_COMMAND,
    "[Service]\nExecStart=\n\n  ExecStart = :\"/opt/session-mesh/mesh-ptyhost\"\n",
], ids=["reset-then-native", "reset-spaced"])
def test_a_dropin_that_replaces_the_python_host_with_the_native_one_is_preserved(tmp_path, dropin):
    # The effective command (after the drop-in) is the native host: nothing to refuse, nothing to change.
    result, pty, web, effects, _ = _install(tmp_path, loaded=True, active=True, local_kind="dropin",
                                           native=False, pty_text=PYTHON_UNIT, dropin_text=dropin)
    assert result.returncode == 0, result.stderr
    assert b"Python PTY host" not in result.stderr
    assert pty.read_text() == PYTHON_UNIT
    assert (pty.parent / "session-mesh-pty.service.d/foreign.conf").read_text() == dropin
    assert "--user start session-mesh-pty.service" not in effects


@pytest.mark.parametrize("fragment,dropin,offender", [
    (NATIVE_COMMAND, "[Service]\nExecStart=\nExecStart=:\"/usr/bin/python3\" \"/old/ptyhost.py\"\n", "foreign.conf"),
    (PYTHON_UNIT, "[Service]\nExecStart=:\"/opt/session-mesh/mesh-ptyhost\"\n", "session-mesh-pty.service"),
    (PYTHON_UNIT, "[Service]\nRestart=always\n", "session-mesh-pty.service"),
], ids=["dropin-sets-python", "dropin-adds-native-without-reset", "dropin-without-execstart"])
def test_a_dropin_whose_effective_command_runs_the_python_host_is_refused(tmp_path, fragment, dropin, offender):
    result, pty, web, effects, _ = _install(tmp_path, loaded=True, active=True, local_kind="dropin",
                                           native=False, pty_text=fragment, dropin_text=dropin)
    assert result.returncode == 1
    assert b"Python PTY host" in result.stderr
    assert offender.encode() in result.stderr
    assert web.read_text() == "web sentinel\n"
    assert effects == ""


@pytest.mark.parametrize("active", [False, True])
def test_existing_configuration_preserved_without_native(tmp_path, active):
    result, pty, _, effects, _ = _install(tmp_path, loaded=True, active=active, native=False)
    assert result.returncode == 0, result.stderr
    assert pty.read_text() == "foreign PTY config\n"
    assert ("--user start session-mesh-pty.service" in effects) is not active


@pytest.mark.parametrize("options", [
    {"query_ok": False}, {"local_kind": "dangling"},
    {"local_kind": "dropin"}, {"endpoint": True},
    {"loaded": True, "needs_reload": "yes"}, {"loaded": True, "needs_reload": ""},
    {"missing_template": True},
    {"loaded": True, "local_kind": "dangling"},
    {"loaded": True, "local_kind": "mask"},
    {"loaded": True, "manager_state": ("activating", "start")},
    {"loaded": True, "manager_state": ("active", "exited")},
    {"arguments": EXPLICIT, "binary_fault": "nonexec"}, {"arguments": EXPLICIT, "binary_fault": "directory"},
])
def test_ambiguous_or_unavailable_refuses_before_mutation(tmp_path, options):
    result, _, web, effects, _ = _install(tmp_path, **options)
    assert result.returncode == 1
    assert web.read_text() == "web sentinel\n"
    assert effects == ""


def test_explicit_migration_refuses_before_web_write(tmp_path):
    result, pty, web, effects, _ = _install(
        tmp_path, EXPLICIT, loaded=True, active=True,
    )
    assert result.returncode == 1
    assert pty.read_text() == "foreign PTY config\n"
    assert web.read_text() == "web sentinel\n"
    assert effects == ""


def test_vendor_only_configuration_does_not_create_local_pty_unit(tmp_path):
    result, pty, _, effects, _ = _install(tmp_path, loaded=True, active=True,
                                         native=False, vendor_only=True)
    assert result.returncode == 0, result.stderr
    assert not pty.exists()
    assert "--user start session-mesh-pty.service" not in effects


def test_native_symlink_resolves_to_executable_target(tmp_path):
    result, pty, _, _, binary = _install(tmp_path, EXPLICIT, binary_fault="symlink")
    assert result.returncode == 0, result.stderr
    assert f'ExecStart=:"{binary.resolve()}"' in pty.read_text()


def test_loaded_foreign_dropin_is_preserved(tmp_path):
    result, pty, _, _, _ = _install(tmp_path, loaded=True, active=True,
                                   vendor_only=True, local_kind="dropin", native=False)
    assert result.returncode == 0, result.stderr
    assert not pty.exists()
    assert (pty.parent / "session-mesh-pty.service.d/foreign.conf").read_text() == "foreign sentinel\n"


@pytest.mark.parametrize("arguments", [
    ("--unknown",), ("--uninstall", "extra"), ("--pty-backend", "native"),
    ("--ptyhost", "relative"), ("--ptyhost", ""),
    ("--ptyhost", "BINARY", "--ptyhost", "BINARY"),
])
def test_invalid_selectors_refuse_without_effects(tmp_path, arguments):
    result, pty, web, effects, _ = _install(tmp_path, arguments)
    assert result.returncode == 2
    assert not pty.exists()
    assert web.read_text() == "web sentinel\n"
    assert effects == ""


@pytest.mark.parametrize("binary_name", ["host", "host space", "host%", "host$"])
def test_literal_native_path_escaping(tmp_path, binary_name):
    result, pty, _, _, binary = _install(
        tmp_path, ("--ptyhost", "BINARY"), binary_name=binary_name,
    )
    assert result.returncode == 0, result.stderr
    escaped = str(binary).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%")
    assert f'ExecStart=:"{escaped}"' in pty.read_text()
    # Actual systemd offline parser, rooted in this owned fixture: no manager,
    # host generators or executable invocation. Mirror the literal executable
    # within that root so verify checks the intended decoded path exists.
    offline = tmp_path / "offline"
    mirrored = offline / str(binary).lstrip("/")
    mirrored.parent.mkdir(parents=True)
    shutil.copy2(binary, mirrored)
    unit_dir = offline / "etc/systemd/system"
    unit_dir.mkdir(parents=True)
    unit = unit_dir / "literal.service"
    unit.write_text(pty.read_text().replace("[Unit]\n", "[Unit]\nDefaultDependencies=no\n"))
    checked = subprocess.run(
        ["/usr/bin/systemd-analyze", f"--root={offline}", "--generators=no",
         "--man=no", "verify", str(unit)],
        env={"PATH": "/usr/bin:/bin", "LC_ALL": "C",
             "SYSTEMD_ENVIRONMENT_GENERATOR_PATH": str(offline / "empty-generators")},
        stdin=subprocess.DEVNULL, capture_output=True, timeout=5,
    )
    assert checked.returncode == 0, checked.stderr


@pytest.mark.parametrize("binary_name", ['host"', "host\\", "host'", "host*", "host?", "host["])
def test_unsupported_systemd_executable_path_refuses_before_effects(tmp_path, binary_name):
    result, pty, web, effects, _ = _install(
        tmp_path, ("--ptyhost", "BINARY"), binary_name=binary_name,
    )
    assert result.returncode == 1
    assert b"unsupported quote/backslash" in result.stderr
    assert not pty.exists()
    assert web.read_text() == "web sentinel\n"
    assert effects == ""


def test_uninstall_preserves_existing_pty_configuration(tmp_path):
    result, pty, web, effects, _ = _install(tmp_path, ("--uninstall",), loaded=True, active=True)
    assert result.returncode == 0, result.stderr
    assert pty.read_text() == "foreign PTY config\n"
    assert not web.exists()
    assert effects.splitlines() == [
        "--user disable --now session-mesh.service", "--user daemon-reload",
        "tailscale serve --https=443 off",
    ]
