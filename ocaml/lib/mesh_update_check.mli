(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The "update available" decision: which published release, if any, an
    installation announces, and the cached answer of GitHub's releases list.

    Nothing here downloads or runs a release. The only network access is the
    [fetch] function given to {!refresh}, called at most once per {!period}
    unless the caller forces it. *)

module Version = Mesh_update_version

(** What the owner wants to hear about ([MESH_UPDATE_NOTICE]). [Off] also means
    that no request is made. *)
type level = All | Minor | Major | Security_only | Off

val level_of_string : string -> level option
(** [all], [minor], [major], [security] or [none], in any case. *)

type release = {
  tag : string;
  version : Version.t;
  security : bool;
  published : string;
      (** GitHub's [published_at] (YYYY-MM-DDTHH:MM:SSZ), or [""]. *)
  notes : string;
      (** The release notes (Markdown) as {!cap_notes} bounds them, or [""]. *)
  truncated : bool;  (** The notes were cut at {!notes_limit}. *)
}

val notes_limit : int
(** 65536 bytes. *)

val cap_notes : string -> string * bool
(** The notes kept for the page: line ends made [\n], control characters
    other than [\n] and [\t] removed, at most {!notes_limit} bytes cut at a
    UTF-8 character boundary; [true] when something was cut. *)

val security_marked : string -> bool
(** The convention for a security release: its notes contain a line
    [Security: yes] (case and surrounding blanks ignored). *)

val releases_of_body : string -> (release list, string) result
(** The releases of a GitHub [/releases] answer (a JSON list), with their
    notes and dates. Drafts, pre-releases and tags that are not [vX.Y.Z] are
    left out. *)

type notice = { latest : release; security : bool }
(** [security] is true when a release newer than the running one and not newer
    than [latest] is a security release: upgrading to [latest] brings that fix.
*)

val announce : level -> current:Version.t -> release list -> notice option
(** The newest release above [current] that [level] announces. Any level but
    [Off] announces a security release. *)

type cache = {
  checked_at : float;
  etag : string option;
  releases : release list;
}

val period : float
(** Seconds between two requests: three hours. *)

val read_cache : string -> cache option
(** A cache written before the notes were kept (no [format] 2) is read without
    its ETag, so that the next request brings the whole list once. *)

val write_cache : string -> cache -> unit
(** Written to a temporary file then renamed, mode 0600; the parent directory is
    created (0700) when missing. *)

val make_directory : string -> unit
(** Create the directory and its missing parents (0700). *)

val valid_etag : string -> bool
(** An entity tag safe to send back in [If-None-Match]: [W/]? then a quoted
    string of visible ASCII, at most 200 bytes. *)

type fetched =
  | Not_modified
  | Body of { etag : string option; body : string }
  | Failed of string

val refresh :
  now:float ->
  force:bool ->
  cache_path:string ->
  fetch:(etag:string option -> fetched) ->
  cache option * string option
(** The cached releases, refreshed when the cache is missing, older than
    {!period}, dated in the future, or when [force] is set. The ETag of the
    cached answer is sent back, so an unchanged list costs a [304]. A failed
    request keeps the releases already known and still dates the attempt, so a
    broken network is not asked again before {!period}; with no earlier answer
    the result is then [None]. A cache directory that cannot be written makes
    no request at all (the attempt could not be dated, so every start would ask
    again). The second value is the failure, for diagnostics only. *)
