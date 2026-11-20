(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Version = Mesh_update_version

type level = All | Minor | Major | Security_only | Off

let level_of_string text =
  match String.lowercase_ascii (String.trim text) with
  | "all" -> Some All
  | "minor" -> Some Minor
  | "major" -> Some Major
  | "security" -> Some Security_only
  | "none" -> Some Off
  | _ -> None

type release = {
  tag : string;
  version : Version.t;
  security : bool;
  published : string;
  notes : string;
  truncated : bool;
}

let security_marked body =
  String.split_on_char '\n' body
  |> List.exists (fun line ->
      String.lowercase_ascii (String.trim line) = "security: yes")

let notes_limit = 65536

(* The notes as the page may receive them: line ends (\r\n, a lone \r) made \n, the other
   control characters but \t removed (each would take six bytes in JSON, and
   the host's reply must stay well under the web server's frame limit), and at
   most [notes_limit] bytes, cut before a UTF-8 sequence, never inside one. *)
let cap_notes text =
  let buffer = Buffer.create (String.length text) in
  String.iteri
    (fun index c ->
      match c with
      | '\r' ->
          if index + 1 >= String.length text || text.[index + 1] <> '\n' then
            Buffer.add_char buffer '\n'
      | '\n' | '\t' -> Buffer.add_char buffer c
      | c when c >= ' ' && c <> '\x7f' -> Buffer.add_char buffer c
      | _ -> ())
    text;
  let kept = Buffer.contents buffer in
  if String.length kept <= notes_limit then (kept, false)
  else
    let rec start index =
      if index > 0 && Char.code kept.[index] land 0xc0 = 0x80 then
        start (index - 1)
      else index
    in
    (String.sub kept 0 (start notes_limit), true)

(* GitHub's [published_at]: YYYY-MM-DDTHH:MM:SSZ, or nothing. *)
let published_date text =
  let digit index = text.[index] >= '0' && text.[index] <= '9' in
  if
    String.length text = 20
    && List.for_all digit [ 0; 1; 2; 3; 5; 6; 8; 9; 11; 12; 14; 15; 17; 18 ]
    && text.[4] = '-'
    && text.[7] = '-'
    && text.[10] = 'T'
    && text.[13] = ':'
    && text.[16] = ':'
    && text.[19] = 'Z'
  then text
  else ""


(* A release tag is v<major>.<minor>.<patch>, as the release workflow
   requires; a suffix makes it a pre-release whatever its flag says. *)
let release_version tag =
  if String.length tag < 2 || tag.[0] <> 'v' then None
  else
    match Version.parse tag with
    | Some version when not (Version.is_prerelease version) -> Some version
    | _ -> None

let member_bool name fields =
  match List.assoc_opt name fields with
  | Some (`Bool value) -> value
  | _ -> false

let release_of_json = function
  | `Assoc fields -> (
      let published =
        (not (member_bool "draft" fields))
        && not (member_bool "prerelease" fields)
      in
      match List.assoc_opt "tag_name" fields with
      | Some (`String tag) when published -> (
          match release_version tag with
          | Some version ->
              let body =
                match List.assoc_opt "body" fields with
                | Some (`String body) -> body
                | _ -> ""
              in
              let notes, truncated = cap_notes body in
              let published =
                match List.assoc_opt "published_at" fields with
                | Some (`String text) -> published_date text
                | _ -> ""
              in
              Some
                {
                  tag;
                  version;
                  security = security_marked body;
                  published;
                  notes;
                  truncated;
                }
          | None -> None)
      | _ -> None)
  | _ -> None

let releases_of_body text =
  match Yojson.Safe.from_string text with
  | `List items -> Ok (List.filter_map release_of_json items)
  | _ -> Error "the answer is not a JSON list"
  | exception Yojson.Json_error message -> Error message

type notice = { latest : release; security : bool }

let newer current (release : release) =
  Version.compare release.version current > 0

let level_announces level ~(current : Version.t) (release : release) =
  let v = release.version in
  match level with
  | Off -> false
  | _ when release.security -> true
  | All -> true
  | Minor ->
      v.major > current.major
      || (v.major = current.major && v.minor > current.minor)
  | Major -> v.major > current.major
  | Security_only -> false

let announce level ~current releases =
  let candidates =
    List.filter
      (fun release ->
        newer current release && level_announces level ~current release)
      releases
  in
  let newest best release =
    match best with
    | Some kept when Version.compare kept.version release.version >= 0 -> best
    | _ -> Some release
  in
  match List.fold_left newest None candidates with
  | None -> None
  | Some latest ->
      (* The label is a claim about the named release only: a higher version
         does not necessarily contain a fix released on an older line. *)
      let security = latest.security in
      Some { latest; security }

type cache = {
  checked_at : float;
  etag : string option;
  releases : release list;
}

let period = 3. *. 3600.

let valid_etag text =
  let length = String.length text in
  let start = if length >= 2 && String.sub text 0 2 = "W/" then 2 else 0 in
  length <= 200
  && length - start >= 2
  && text.[start] = '"'
  && text.[length - 1] = '"'
  && String.for_all
       (fun c -> c = '\x21' || (c >= '\x23' && c <= '\x7e'))
       (String.sub text (start + 1) (length - start - 2))

(* Format 2 keeps the notes of each release. An older cache has none: its ETag
   is not sent back, so that the next request brings the whole list once. *)
let cache_format = 2

let cache_to_json cache =
  `Assoc
    [
      ("format", `Int cache_format);
      ("checked_at", `Float cache.checked_at);
      ("etag", match cache.etag with Some etag -> `String etag | None -> `Null);
      ( "releases",
        `List
          (List.map
             (fun release ->
               `Assoc
                 [
                   ("tag", `String release.tag);
                   ("security", `Bool release.security);
                   ("published", `String release.published);
                   ("notes", `String release.notes);
                   ("truncated", `Bool release.truncated);
                 ])
             cache.releases) );
    ]

let cached_release = function
  | `Assoc fields -> (
      match (List.assoc_opt "tag" fields, List.assoc_opt "security" fields) with
      | Some (`String tag), Some (`Bool security) ->
          let text name =
            match List.assoc_opt name fields with
            | Some (`String value) -> value
            | _ -> ""
          in
          (* the cache is this program's own file, but it is read back with
             the same bounds as an answer *)
          let notes, cut = cap_notes (text "notes") in
          let truncated =
            cut
            ||
            match List.assoc_opt "truncated" fields with
            | Some (`Bool value) -> value
            | _ -> false
          in
          Option.map
            (fun version ->
              {
                tag;
                version;
                security;
                published = published_date (text "published");
                notes;
                truncated;
              })
            (release_version tag)
      | _ -> None)
  | _ -> None

let cache_of_json = function
  | `Assoc fields -> (
      let checked_at =
        match List.assoc_opt "checked_at" fields with
        | Some (`Float value) -> Some value
        | Some (`Int value) -> Some (float_of_int value)
        | _ -> None
      in
      let etag =
        match List.assoc_opt "etag" fields with
        | Some (`String etag)
          when valid_etag etag
               && List.assoc_opt "format" fields = Some (`Int cache_format) ->
            Some etag
        | _ -> None
      in
      match (checked_at, List.assoc_opt "releases" fields) with
      | Some checked_at, Some (`List items) ->
          Some
            {
              checked_at;
              etag;
              releases = List.filter_map cached_release items;
            }
      | _ -> None)
  | _ -> None

let read_cache path =
  match Yojson.Safe.from_file path with
  | json -> cache_of_json json
  | exception (Sys_error _ | Yojson.Json_error _) -> None

let rec make_directory path =
  if not (Sys.file_exists path) then (
    make_directory (Filename.dirname path);
    try Unix.mkdir path 0o700 with Unix.Unix_error (Unix.EEXIST, _, _) -> ())

let write_cache path cache =
  make_directory (Filename.dirname path);
  let staged = Printf.sprintf "%s.%d.tmp" path (Unix.getpid ()) in
  let channel =
    open_out_gen
      [ Open_wronly; Open_creat; Open_trunc; Open_binary ]
      0o600 staged
  in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () -> Yojson.Safe.to_channel channel (cache_to_json cache));
  Sys.rename staged path

type fetched =
  | Not_modified
  | Body of { etag : string option; body : string }
  | Failed of string

let is_fresh ~now cache =
  cache.checked_at <= now && now -. cache.checked_at < period

(* A request is made only when its answer can be remembered: with a cache
   directory that cannot be written, every start would ask again. *)
let can_store cache_path =
  let directory = Filename.dirname cache_path in
  try
    make_directory directory;
    Unix.access directory [ Unix.W_OK ];
    true
  with Unix.Unix_error _ | Sys_error _ -> false

(* Writing the cache is best effort: a read-only cache directory must not
   turn a good answer into a failure. *)
let store cache_path cache =
  (try write_cache cache_path cache with Sys_error _ | Unix.Unix_error _ -> ());
  Some cache

let refresh ~now ~force ~cache_path ~fetch =
  let old = read_cache cache_path in
  match old with
  | Some cache when (not force) && is_fresh ~now cache -> (old, None)
  | _ when not (can_store cache_path) ->
      (old, Some "the cache directory cannot be written: no request")
  | _ -> (
      let sent = Option.bind old (fun cache -> cache.etag) in
      (* Without an earlier answer there is nothing to report, but the attempt is still dated. *)
      let attempt error =
        let releases =
          Option.fold ~none:[] ~some:(fun cache -> cache.releases) old
        in
        let stored =
          store cache_path { checked_at = now; etag = sent; releases }
        in
        ((if old = None then None else stored), Some error)
      in
      match (fetch ~etag:sent, old) with
      | Not_modified, Some cache ->
          (store cache_path { cache with checked_at = now }, None)
      | Not_modified, None -> attempt "304 without a cached answer"
      | Failed error, _ -> attempt error
      | Body { etag; body }, _ -> (
          match releases_of_body body with
          | Ok releases ->
              let etag =
                Option.bind etag (fun etag ->
                    if valid_etag etag then Some etag else None)
              in
              (store cache_path { checked_at = now; etag; releases }, None)
          | Error error -> attempt error))
