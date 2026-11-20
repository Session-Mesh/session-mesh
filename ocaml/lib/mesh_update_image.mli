(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The images of the release notes ("What's new" in the update banner):
    [mesh-platform update-image] decides whether an image URL may be fetched,
    fetches it with [curl] and checks what comes back. The web server only
    relays the answer (server.py, [GET /api/update/image]).

    An image is fetched only when its URL is written in the notes the PTY host
    holds, is [https] on [github.com] or a [*.githubusercontent.com] name, and
    that name resolves to public addresses only. [curl] connects to the address
    checked here ([--resolve]), so a second lookup cannot send it elsewhere.
    Redirects are followed by hand, at most {!max_redirects}, and each target is
    checked again. PNG, JPEG, GIF or WebP only, whose leading bytes match the
    type, at most {!size_limit} bytes. At most {!budget_count} fetches per
    {!budget_window} seconds, counted in a file of the cache directory. *)

val size_limit : int
(** 5 MiB. *)

val max_redirects : int
(** 3. *)

val budget_count : int
(** 60. *)

val budget_window : float
(** 600 seconds. *)

type target = {
  fetch_url : string;
  proto : string;  (** curl's [--proto] value. *)
  pin : string option;  (** curl's [--resolve] value. *)
}

val stand_ins_of_string : string -> (string * (string * int)) list
(** The test hook [MESH_UPDATE_IMAGE_TEST_HOSTS]: [name=address:port,...]. *)

val target :
  resolve:(string -> Unix.inet_addr list) ->
  stand_ins:(string * (string * int)) list option ->
  Mesh_update_image_url.url ->
  target option
(** Where the request for [url] goes, or [None] when it must not be made.
    Without stand-ins: [https] to the host pinned to its first address, every
    address of the name being public. With stand-ins (tests only): plain HTTP to
    the stand-in of that name, which must be a loopback address literal or a
    name that passes the same public check; any other name is refused. *)

val curl_arguments : target -> max_time:float -> string list
(** [-q] first (no [.curlrc]), the fixed User-Agent, no proxy, no redirect
    followed by curl, no URL globbing, the size limit, the headers then the body
    on standard output. *)

type answer = { status : int; content_type : string; body : string }
(** [status] is the HTTP status the web server answers: 200 with an image, else
    404 (not an image of the notes), 413, 415, 429 or 502. *)

val response_limit : int
(** The bytes of curl's output read at most: 64 KiB of headers and one byte over
    {!size_limit}. *)

val fetch :
  resolve:(string -> Unix.inet_addr list) ->
  transport:(string list -> Unix.process_status * string) ->
  stand_ins:(string * (string * int)) list option ->
  clock:(unit -> float) ->
  Mesh_update_image_url.url ->
  answer
(** One image, all hops within 20 seconds. [transport] runs curl with the given
    arguments and returns its status and at most {!response_limit} bytes of its
    output. *)

val take_budget : path:string -> now:float -> bool
(** Count one fetch in the file [path] (created 0600, locked), unless
    {!budget_count} were counted in the last {!budget_window} seconds. *)

val answer :
  getenv:(string -> string option) ->
  resolve:(string -> Unix.inet_addr list) ->
  transport:(string list -> Unix.process_status * string) ->
  clock:(unit -> float) ->
  url:string ->
  notes:string ->
  answer
(** The whole decision: 404 for a URL refused by {!image_url} or absent from the
    notes (no request, nothing counted), 429 over the budget (file
    [update-image-fetches] of the cache directory), else {!fetch}. *)

val resolve : string -> Unix.inet_addr list
(** The addresses of a name ([getaddrinfo]), or [[]]. *)

val run_curl : string list -> Unix.process_status * string
(** curl as a child, its standard output read up to {!response_limit} (then
    killed); standard input and error are [/dev/null]. *)
