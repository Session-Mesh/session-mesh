(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

(** One projected conversation transfer between matching OpenCode versions
    (2.3.2 or 2.4.2). No agent launch,
    credential copy, whole database copy or live-session checkpoint. The caller
    must fence both accounts and provide validated, disjoint profile XDG roots,
    private operation runtime directories and workspace locations. HOME is the
    runner's common HOME, not a per-profile root or an OS isolation boundary.
    The source and target must name the same exact workspace location: native
    2.3.2 recomputes [subpath] on import, and this adapter does not verify
    relocations. Profile XDG and operation runtime roots remain disjoint. *)

type context = {
  home : string;
  config : string;
  data : string;
  state : string;
  cache : string;
  runtime : string;
  location : string;
}

type verb = [ `Get | `Post ]
val disjoint : context -> context -> bool
(** Compare existing profile and runtime roots, including physical ancestry.
    The caller must separately validate directory custody. *)

type request =
  context ->
  verb ->
  string ->
  string option ->
  (int * Yojson.Safe.t, string) result

type report = { messages : int }

val native_fork_notice : string
(** Exact 2.3.2 built-in fork notice, used to refuse modified instruction
    content and to preserve its pending synthetic delivery across import. *)

type lineage = {
  logical_id : string;
  epoch : int;
  source_profile : string;
  target_profile : string;
  parent_native_id : string;
  native_id : string;
  boundary_message_id : string;
  messages : int;
}

val transfer :
  request:request ->
  source:context ->
  target:context ->
  session_id:string ->
  (report, string) result
(** Stateless policy/checkpoint choreography for one export and one import.
    A lost import acknowledgement is [transfer_uncertain], never a retry. The
    caller must reconcile the target manually. Currently active instruction
    entries refuse, while this stateless API continues to refuse native forks,
    revert history and workspace IDs that the import cannot preserve. A tool
    row containing a [jobID] is refused even when its job has already finished:
    this adapter does not yet qualify the pinned provider's job-status API.
    Export/import omit historical instruction epochs.
    Export and context equality do not prove the next model input. Errors are
    fixed path-free codes. Non-identical workspace locations refuse with
    [transfer_invalid_input] before any request. *)

val fork_transfer :
  request:request ->
  source:context ->
  target:context ->
  parent_native_id:string ->
  logical_id:string ->
  epoch:int ->
  source_profile:string ->
  target_profile:string ->
  receipt_directory:string ->
  operation_id:string ->
  (lineage, string) result
(** Create a native fork, verify that its inherited transcript equals
    the complete idle parent except for native-remapped message IDs, then
    import it create-only and restore the exact native pending fork notice.
    [receipt_directory]
    is an existing Mesh-controlled, private persistent directory; each phase
    is a create-only, fsynced file keyed by [operation_id]. Never reuse an
    operation ID after any error: an unacknowledged fork or import, or any
    receipt failure after the fork POST, is [transfer_uncertain], and originals
    remain untouched. The imported session keeps the native ID and messages,
    but native import drops [fork] provenance and its pending notice; the
    receipt binds its original native parent and boundary to the Mesh logical
    identity, profiles and epoch.
    Historical instruction epochs remain unsupported. The caller must verify
    its independently fenced epoch before any live use: these phase files are
    not an authoritative journal or context-revision CAS. This is not a
    live-safe checkpoint or a switching coordinator. Non-identical workspace
    locations refuse before a fork or receipt. *)

val run :
  binary:string ->
  source:context ->
  target:context ->
  session_id:string ->
  (report, string) result
(** Start separate private loopback OpenCode servers with curated environments,
    use an ephemeral authentication secret and private 0600 bounded HTTP request
    files (transcript never enters argv), stop only those child processes. Native
    API import is not a cross-server transaction; pending work, active sessions,
    dependencies, unsupported states and uncertain replies refuse. This process
    preflight is not an authoritative freeze: the caller must supply a separate
    fencing receipt. A successful report verifies an offline storage projection,
    not a live-safe transfer or resumable A-to-B-to-A operation. *)

val run_fork :
  binary:string ->
  source:context ->
  target:context ->
  parent_native_id:string ->
  logical_id:string ->
  epoch:int ->
  source_profile:string ->
  target_profile:string ->
  receipt_directory:string ->
  operation_id:string ->
  (lineage, string) result
(** Native-server transport for [fork_transfer]. No shared service or provider
    is started by this function; an already configured offline source session
    is required. The caller must fence the independent receipt directory. *)
