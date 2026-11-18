(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [mesh-platform update-check]: the installation's own release, its settings,
    the request to GitHub and what is reported to the web server and the [mesh]
    command. *)

val releases_url : string
(** GitHub's public releases list of Session-Mesh/session-mesh, first page. *)

type installation = {
  tag : string;
  version : Mesh_update_version.t;
  share : string;
}

val installation_of_release_dir : string -> installation option
(** A release directory [<share>/releases/<tag>], as installed by install.sh. *)

val installation_of_executable : string -> installation option
(** The release a program runs from: [<share>/releases/<tag>/bin/<program>]
    after resolving symbolic links. [None] for a source install or an extracted
    bundle, whose version is not known. *)

val following_current : installation -> installation
(** The release [<share>/current] points at when it is a newer release of the
    same share, else the installation itself. For a program that outlives an
    upgrade: the PTY host keeps running the release it started from, but the
    notice must not announce the release the owner has just installed. *)

type outcome =
  | Disabled
      (** [MESH_UPDATE_CHECK=0] or [MESH_UPDATE_NOTICE=none]: no request *)
  | Unknown_version  (** not a release install: no request *)
  | Unavailable  (** no answer has been obtained yet *)
  | Current  (** nothing to announce at this level *)
  | Available of {
      notice : Mesh_update_check.notice;
      installation : installation;
    }

val cache_path : (string -> string option) -> string option
(** [MESH_CACHE_DIR] (absolute) or [~/.cache/session-mesh], then
    [update-check.json]. *)

val settings_name : string
(** [update-notice]: the file's name. *)

val settings_path : (string -> string option) -> string option
(** [update-notice] in the configuration directory: [MESH_CONF_DIR] (absolute)
    or [~/.config/session-mesh]. *)

val settings_limit : int
(** The largest settings file read, in bytes. *)

type settings = { check : string option; notice : string option }
(** What the settings file says: [check] is ["0"] or ["1"], [notice] one of
    the levels; [None] for a key the file does not set. *)

val parse_settings : string -> (settings, string) result
(** [check=1|0] and [notice=all|minor|major|security|none], one per line, each
    at most once. Blank lines, [#] comments and other lines are ignored; a
    known key with another value, or set twice, is an [Error]. *)

val with_settings :
  (string -> string option) -> (string -> string option) * string option
(** The environment as {!check} must see it: the settings file replaces
    [MESH_UPDATE_CHECK] and [MESH_UPDATE_NOTICE] for the keys it sets, the
    environment stays the default for the others and when the file is absent.
    The file is read at every call, so that a change applies to a long-lived
    program without a restart. A symbolic link, a file that is not a regular
    file of this user, one writable by group or others, one over
    {!settings_limit} bytes, or one that does not parse changes nothing; the
    second value says why, for [--debug]. *)

val check :
  getenv:(string -> string option) ->
  installation:installation option ->
  request:bool ->
  force:bool ->
  now:float ->
  fetch:(etag:string option -> Mesh_update_check.fetched) ->
  outcome * string option
(** The decision for this installation; the second value is the reason a request
    failed or a setting was ignored, for [--debug]. *)

val user_agent : string
(** The fixed User-Agent of the request. *)

val curl_arguments :
  ?url:string ->
  etag:string option ->
  headers:string ->
  body:string ->
  unit ->
  string list
(** The [curl] command line, [-q] first. *)

val run_curl : string list -> Unix.process_status * string
(** Run it with output discarded; the status and the -w text. *)

val clean_stale : directory:string -> unit
(** Remove the request's working files, and staged cache files, that a killed
    process left in [directory] more than ten minutes ago. *)

val fetch_with :
  run:(string list -> Unix.process_status * string) ->
  directory:string ->
  etag:string option ->
  Mesh_update_check.fetched
(** One request through [run] (which starts the command line and returns its
    status and its [-w] text). The working files are created in [directory],
    the cache directory, and removed afterwards, also when [run] is
    interrupted. Every failure is returned, none raised. *)

val curl_fetch :
  directory:string -> etag:string option -> Mesh_update_check.fetched
(** One HTTPS GET of {!releases_url} through [curl], without credentials, run
    and awaited in the calling thread ({!fetch_with} with {!run_curl}). *)

val cache_directory : (string -> string option) -> string option
(** The directory of {!cache_path}. *)

val curl_fetch_in_cache :
  (string -> string option) -> etag:string option -> Mesh_update_check.fetched
(** {!curl_fetch} with working files in {!cache_directory}. *)

val to_json : home:string option -> outcome -> Yojson.Safe.t

val line : home:string option -> outcome -> string option
(** One English sentence when an update is available. *)
