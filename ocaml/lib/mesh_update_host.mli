(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The update check as the PTY host runs it: once at startup, then whenever
    three hours have passed, in one background fiber that keeps the latest
    answer in memory for the [update_notice] request.

    The check itself is {!Mesh_update_report.check}, unchanged. What this module
    adds is a schedule and a bound: the request is an Eio child with an absolute
    time limit, killed and reaped when it is exceeded or when the host stops,
    and every failure is swallowed (reported only under
    [MESH_UPDATE_DEBUG=1]). The host's event loop and its sessions never wait
    on it, and the only file it writes is the cache of {!Mesh_update_check}. *)

type t
(** The latest answer, in memory. *)

val create : unit -> t

val latest : t -> Yojson.Basic.t
(** The [update] value of the host's [update_notice] reply: the object that
    [mesh-platform update-check] prints when a newer release is announced
    ([status] ["available"], [latest], [security], [notes_url],
    [upgrade_command], [line], [notes]), [`Null] otherwise. *)

val notes : t -> Yojson.Basic.t
(** The [notes] value of the host's [update_notes] reply: the notes of the
    release {!latest} announces ({!Mesh_update_report.notes_json}), [`Null]
    when nothing is announced (the feature off included) or the release has
    none. Set with {!latest}, at the same look. *)

val tick : float
(** Seconds between two looks at the cache (ten minutes). A request is made
    only when {!Mesh_update_check.period} has passed since this host's last
    one, whatever the cache says: an unwritable cache never causes a request
    per tick. *)

val loop :
  t ->
  getenv:(string -> string option) ->
  installation:(unit -> Mesh_update_report.installation option) ->
  now:(unit -> float) ->
  sleep:(float -> unit) ->
  fetch:(etag:string option -> Mesh_update_check.fetched) ->
  log:(string -> unit) ->
  unit
(** Check, sleep {!tick}, check again, until the installation is not a release
    (a source install): then it returns without any request. Every look reads
    the settings file again ({!Mesh_update_report.with_settings}: [update-notice]
    in the configuration directory over [MESH_UPDATE_CHECK] and
    [MESH_UPDATE_NOTICE]), so a change applies without a restart: when the
    feature is off ([check=0], [notice=none]) a look makes no request and
    drops the announcement ({!latest} is [`Null]), and the loop goes on to see
    the file turn it on again. [installation] is asked at
    every look: the host outlives upgrades (see
    {!Mesh_update_report.following_current}). [now] is the wall clock
    (the cache's dates), [sleep] and [fetch] are the caller's, which makes the
    schedule testable with a fake clock and a fake request. The first available
    answer is logged once through [log]. Failures are logged only when
    [MESH_UPDATE_DEBUG=1]. Never raises, except the cancellation of the fiber. *)

val run_curl :
  mgr:_ Eio_unix.Process.mgr ->
  clock:_ Eio.Time.Mono.t ->
  seconds:float ->
  string list ->
  Unix.process_status * string
(** Start the command as an Eio child whose standard input and error are
    [/dev/null] (the host copies and buffers nothing from them) and return its
    status and its standard output (at most 64 bytes read). After
    [seconds], or when the calling fiber is cancelled, the child is killed and
    reaped before this returns; a killed child is reported as [WSIGNALED]. *)

val start :
  t ->
  sw:Eio.Switch.t ->
  mgr:_ Eio_unix.Process.mgr ->
  clock:_ Eio.Time.Mono.t ->
  log:(string -> unit) ->
  unit
(** Fork the {!loop} as a daemon fiber of [sw] for this program's own release
    ([Sys.executable_name], or the newer release [current] points at), requests through {!run_curl} limited to
    {!request_limit} seconds. Cancelling [sw] ends it and kills a running
    request. *)

val request_limit : float
(** Thirty seconds, above curl's own [--max-time 20]. *)
