(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The context of an operation: which repository, which host, which clock.
    Clock and host are injectable, as [WL_NOW] and [WL_HOST] are for [wl]. *)

type t = {
  root : string;  (** the data repository *)
  host : string;  (** short host name used in event file names *)
  now : unit -> int;  (** epoch seconds *)
  rng : Random.State.t;  (** draws task, project and blocker ids *)
  commit : bool;  (** commit each write when the repository is a git repository *)
  lock_timeout : float;  (** seconds to wait for [.wl.lock] *)
  warn : string -> unit;  (** receives non-fatal problems of writes, such as a failed commit *)
}

val make :
  root:string ->
  ?host:string ->
  ?now:(unit -> int) ->
  ?rng:Random.State.t ->
  ?commit:bool ->
  ?lock_timeout:float ->
  ?warn:(string -> unit) ->
  unit ->
  t
(** Explicit construction (tests, embedding). Defaults: the machine's short
    host name, the system clock, a self-initialised generator, commit on,
    30 s. *)

val of_env :
  ?getenv:(string -> string option) ->
  ?commit:bool ->
  ?warn:(string -> unit) ->
  unit ->
  (t, Err.t) result
(** Discover the repository from the environment: [WL_HOME] (a leading [~] or
    [~user] is expanded), else [$HOME/worklog-data], else the legacy
    [$HOME/worklog] ([HOME] unset or empty falls back to the account's home
    directory, never to a relative path); it is valid when [taxonomy.yaml] is a
    file there; the current directory is never searched. Both default locations valid is an error (exit 6). [WL_HOST]
    overrides the host name (normalised, not cut at a dot), [WL_NOW] ([YYYY-MM-DDTHH:MM:SSZ]) the clock,
    [WL_LOCK_TIMEOUT] the lock timeout in seconds (not finite: 30; negative: 0). [getenv] defaults to
    {!Sys.getenv_opt}. *)

val host_name : string -> string
(** Normalise a system host name: first label, lowercase, characters outside
    [[a-z0-9-]] replaced by [-] (one per code point), empty becomes [host]. An
    explicit host ([make ~host], [WL_HOST]) gets the same treatment but is not
    cut at its first dot. *)

val events_dir : t -> string
val tasks_dir : t -> string
val taxonomy_path : t -> string
val lock_path : t -> string
