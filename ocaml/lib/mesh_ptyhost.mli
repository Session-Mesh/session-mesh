(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

val log : ('a, unit, string, unit) format4 -> 'a
(** Best-effort diagnostics: output failures do not stop the host. *)

val parse : string -> (Yojson.Basic.t, string) result
(** Parse bounded control JSON: at most 256 KiB, valid UTF-8 and depth 128. *)

val valid_session_name : string -> bool
(** Pure existing host name policy: nonempty valid UTF-8 without NUL. No new
    length limit; this validates shape, not session identity or authority. *)

(** [attach_if] pins its stream to the selected [created] value. An in-place
    agent restart retires those streams, leases and queued/active conditional
    input before advancing [created]. Legacy name-only attachments and their
    ordinary input continue on the retained PTY. *)

val valid_creation_receipt : string -> bool
(** Validate the canonical boot-instance/generation receipt syntax only. A
    receipt is physical provenance, not an action permit. [new_bound] returns it
    while legacy [new] remains unchanged. [new_bound] requires canonical
    positive decimal [deadline_ns] in the same Eio monotonic nanosecond clock
    domain, checked before creation and immediately before physical process
    entry. [lookup_bound]/[attach_bound] match the exact stored live session
    object, optionally checking its name for consistency. *)

(** [geometry_bound] uses the same exact live receipt selection, permits only
    [op], [creation_receipt] and optional consistency [name], and returns [ok],
    [name], [creation_receipt], [kind="kernel-sample"], [rows] and [cols]. It
    samples the already-owned PTY FD without attachment, resize, input or lease
    effects. Invalid/zero dimensions refuse instead of assuming defaults. This
    point-in-time sample supplies no byte cursor, resize timeline or VT screen
    checkpoint and cannot establish a complete replay/bootstrap. *)

val valid_demo_capability : string -> bool
(** Syntax only: 32 random bytes encoded as lowercase hexadecimal. It grants no
    authority without a live host lookup and runner-owned admission. *)

(** [new_preset_bound] also mints a private, per-incarnation demo self
    capability in the spawned child's environment. [lookup_demo_self] accepts
    exactly [op] and that capability, returning only the receipt while the
    native object is live. It never selects by name or grants publication by
    itself; generic caller-supplied environments cannot set the reserved key.
    This is a host-side primitive for a future local MCP binding, not isolation
    against malicious processes running under the same Unix UID. *)

val run :
  ?private_preset_directory:string ->
  ?agent_preset_config:string * string ->
  unit ->
  unit
(** Run the native single-domain PTY host (Linux and macOS), the [mesh-ptyhost]
    program that the installer sets up. It owns the mesh sessions: stopping it
    ends them. It holds [ptyhost.lock] beside its socket for its whole life;
    while another host holds that lock or answers on the socket, it logs
    [not starting] and exits with status 1. Attachments, output, replay, resize,
    and bounded terminal input are supported. Optional trusted startup
    provisioning opens and retains one owner-private directory capability for
    the closed [new_preset_bound] shell selector. [preset_ready] accepts exactly
    [op] and [preset="shell"], revalidates that held directory's
    UID/kind/private mode and returns only [version=1,ready=true]. It refuses
    while stopping or for unknown selectors/fields; it never spawns or releases
    the capability. This point-in-time fact does not promise future shell
    executable availability. [agent_preset_config] optionally admits a private,
    digest-checked startup snapshot of fixed Claude/Codex launchers and held
    directories. Its opaque selectors never accept request argv, CWD or SID;
    custody failure refuses without spawning. Absent configuration remains off.
    Legacy operations retain their historical behavior. Setting
    [MESH_PTY_AGENT_UID] before startup enables the opt-in Unix identity split:
    the non-root host remains under its dedicated UID; every generic shell is
    launched by root-owned [setpriv], drops to that local account's UID/GID,
    clears groups and capabilities, sets no-new-privileges, then changes to the
    requested CWD only after the drop. Parent runtime/home/socket paths are not
    inherited. Missing privilege or launcher failure never falls back to a
    same-UID child. Private presets are refused in this mode until they can be
    revalidated without opening an agent-owned directory as the host UID. *)

(** Native discovery also offers closed [list_legacy_bound] and
    [lookup_legacy_bound] operations. They select only objects allocated by
    legacy [new], using an immutable internal birth flag derived from the
    allocation operation, never metadata or journal absence. All bound/preset
    allocations are excluded, including manual bound requests. These are receipt
    observations, not authorization grants; consumers must recheck the exact
    current receipt and origin at observation and physical use. Existing
    [list_bound]/[lookup_bound] replies and behavior are unchanged. *)

(** [processes] serves the process facts of {!Mesh_pty_processes} to clients
    that cannot read [/proc] (the server on macOS). It is read-only, runs in a
    system thread so that session I/O continues during the scan, and is refused
    while stopping and in the Unix identity split. *)

(** [update_notice] (exactly [op]) answers [ok] and [update], the latest answer
    of the release check that this host runs in the background
    ([Mesh_update_host]): the "update available" object or [null]. It reads
    memory only. An older host answers [invalid request] to it, and no older
    client sends it. *)

(** [update_notes] (exactly [op]) answers [ok] and [notes]: the release notes
    of the release [update_notice] announces ([tag], [published], [body] at
    most 64 KiB of Markdown, [truncated], [notes_url]), or [null]. Memory only:
    the notes come from the same releases list as the notice, no request is
    made for them. *)

(** Native Projects uses six version-1 [project_*] requests. It owns a fixed
    startup [MESH_CONF_DIR/projects.json] (effective user's persistent
    [.config/session-mesh] by default), and refuses before registry access in
    identity-split mode. Discovery is independent of lazy store readiness. Four
    admitted filesystem workers serve bounded typed projections and atomic
    byte-CAS metadata mutations outside terminal fibers. Caller socket
    permissions remain the local boundary; no peer-UID/remote grant is inferred.
    Worker and cooperative writer ownership survives caller timeout. *)

(** The additional four [project_observation_*] requests use independent
    two-worker and four-control reservations. Startup-fixed absolute
    [MESH_PROJECT_OBSERVATION_RUNTIME] and [MESH_PROJECT_OBSERVATION_ENTRY]
    select the trusted collector; readiness discovery exposes no paths.
    Capture is asynchronous, including filesystem access. Cancellation and
    the thirty-second monotonic deadline initiate cleanup; unverified collector
    exit or undrained stdio retains its charged slot. Complete catalogs use
    canonical 128-KiB pages, SHA-256, a two-MiB total limit and finite monotonic
    retention. Rich catalog admission belongs to the trusted typed collector;
    native independently checks envelope/scope/top-level catalog/witness and
    separately observes collector exit and pipe EOF. This is no arbitrary
    descendant, hard-reap, heap or RSS bound. *)
