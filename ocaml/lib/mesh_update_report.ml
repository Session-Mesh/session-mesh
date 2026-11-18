(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module C = Mesh_update_check

let repository = "Session-Mesh/session-mesh"

let releases_url =
  "https://api.github.com/repos/" ^ repository ^ "/releases?per_page=30"

let notes_url tag = "https://github.com/" ^ repository ^ "/releases/tag/" ^ tag

type installation = {
  tag : string;
  version : Mesh_update_version.t;
  share : string;
}

let installation_of_release_dir dir =
  let tag = Filename.basename dir and releases = Filename.dirname dir in
  match Mesh_update_version.parse tag with
  | Some version
    when Filename.basename releases = "releases"
         && String.length tag > 1
         && tag.[0] = 'v'
         && not (Mesh_update_version.is_prerelease version) ->
      Some { tag; version; share = Filename.dirname releases }
  | _ -> None

let installation_of_executable path =
  match Unix.realpath path with
  | resolved ->
      (* bin/ holds the programs of a release; libexec/ holds the native PTY
         host that the bundle's bin/mesh-ptyhost wrapper executes. *)
      let dir = Filename.dirname resolved in
      if List.mem (Filename.basename dir) [ "bin"; "libexec" ] then
        installation_of_release_dir (Filename.dirname dir)
      else None
  | exception Unix.Unix_error _ -> None

(* A long-lived program (the PTY host is not restarted by an upgrade) keeps the
   release it started from. The installation it belongs to is what [current]
   points at when that is a newer release of the same share. *)
let following_current own =
  let current = Filename.concat (Filename.concat own.share "current") "" in
  match Unix.realpath current with
  | resolved -> (
      match installation_of_release_dir resolved with
      | Some installed
        when installed.share = own.share
             && Mesh_update_version.compare installed.version own.version > 0 ->
          installed
      | _ -> own)
  | exception Unix.Unix_error _ -> own

type outcome =
  | Disabled
  | Unknown_version
  | Unavailable
  | Current
  | Available of { notice : C.notice; installation : installation }

let cache_path getenv =
  let base =
    match (getenv "MESH_CACHE_DIR", getenv "HOME") with
    | Some dir, _ when dir <> "" && not (Filename.is_relative dir) -> Some dir
    | _, Some home when home <> "" && not (Filename.is_relative home) ->
        Some (Filename.concat (Filename.concat home ".cache") "session-mesh")
    | _ -> None
  in
  Option.map (fun dir -> Filename.concat dir "update-check.json") base

(* An unknown MESH_UPDATE_NOTICE value keeps the default, [all], and says so
   under --debug. *)
let level getenv =
  match getenv "MESH_UPDATE_NOTICE" with
  | None -> (C.All, None)
  | Some text when String.trim text = "" -> (C.All, None)
  | Some text -> (
      match C.level_of_string text with
      | Some level -> (level, None)
      | None ->
          ( C.All,
            Some
              ("MESH_UPDATE_NOTICE: unknown value " ^ String.escaped text
             ^ ", using all") ))

(* ---- the settings file *)

let settings_name = "update-notice"
let settings_limit = 4096

let config_directory getenv =
  match (getenv "MESH_CONF_DIR", getenv "HOME") with
  | Some dir, _ when dir <> "" && not (Filename.is_relative dir) -> Some dir
  | _, Some home when home <> "" && not (Filename.is_relative home) ->
      Some (Filename.concat (Filename.concat home ".config") "session-mesh")
  | _ -> None

let settings_path getenv =
  Option.map
    (fun dir -> Filename.concat dir settings_name)
    (config_directory getenv)

(* The file's whole text, or why it is not used. A symbolic link, a file that
   is not a regular file of this user, one that group or others can write, or
   one over [settings_limit] bytes is refused, like the rest of the mesh's own
   configuration. [Ok None] is an absent file. *)
let read_settings_file path =
  (* OCaml's Unix has no O_NOFOLLOW: the link is seen by lstat, and the opened
     file must be the one lstat saw. *)
  match Unix.lstat path with
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok None
  | exception Unix.Unix_error (error, _, _) -> Error (Unix.error_message error)
  | { Unix.st_kind = Unix.S_LNK; _ } -> Error "is a symbolic link"
  | seen -> (
      match
        Unix.openfile path
          [ Unix.O_RDONLY; Unix.O_CLOEXEC; Unix.O_NONBLOCK; Unix.O_NOCTTY ]
          0
      with
      | exception Unix.Unix_error (error, _, _) ->
          Error (Unix.error_message error)
      | descriptor ->
      Fun.protect
        ~finally:(fun () -> Unix.close descriptor)
        (fun () ->
          let stat = Unix.fstat descriptor in
          if stat.Unix.st_ino <> seen.Unix.st_ino
             || stat.Unix.st_dev <> seen.Unix.st_dev
          then Error "changed while it was opened"
          else if stat.Unix.st_kind <> Unix.S_REG then Error "is not a regular file"
          else if stat.Unix.st_uid <> Unix.geteuid () then
            Error "belongs to another user"
          else if stat.Unix.st_perm land 0o022 <> 0 then
            Error "is writable by group or others"
          else if stat.Unix.st_size > settings_limit then
            Error "is larger than 4096 bytes"
          else
            let channel = Unix.in_channel_of_descr descriptor in
            match In_channel.really_input_string channel stat.Unix.st_size with
            | Some text -> Ok (Some text)
            | None -> Error "changed while it was read"
            | exception (Sys_error _ | Unix.Unix_error _) ->
                Error "cannot be read"))

type settings = { check : string option; notice : string option }

let no_settings = { check = None; notice = None }

(* [check=1|0] and [notice=all|minor|major|security|none], one per line, each
   at most once. Blank lines, [#] comments and other lines are ignored; a known
   key with another value, or set twice, makes the whole file unusable. *)
let parse_settings text =
  let rec go settings = function
    | [] -> Ok settings
    | raw :: rest -> (
        let line = String.trim raw in
        match String.index_opt line '=' with
        | None -> go settings rest
        | Some _ when line.[0] = '#' -> go settings rest
        | Some index -> (
            let key = String.trim (String.sub line 0 index)
            and value =
              String.trim
                (String.sub line (index + 1) (String.length line - index - 1))
            in
            match key with
            | "check" when settings.check <> None -> Error "check is set twice"
            | "check" when value = "0" || value = "1" ->
                go { settings with check = Some value } rest
            | "check" -> Error ("check: unknown value " ^ String.escaped value)
            | "notice" when settings.notice <> None ->
                Error "notice is set twice"
            | "notice" when C.level_of_string value <> None ->
                go { settings with notice = Some value } rest
            | "notice" ->
                Error ("notice: unknown value " ^ String.escaped value)
            | _ -> go settings rest))
  in
  go no_settings (String.split_on_char '\n' text)

let with_settings getenv =
  let settings, problem =
    match settings_path getenv with
    | None -> (no_settings, None)
    | Some path -> (
        let ignored reason =
          (no_settings, Some (settings_name ^ " " ^ reason ^ ": ignored"))
        in
        match read_settings_file path with
        | Ok None -> (no_settings, None)
        | Error reason -> ignored reason
        | Ok (Some text) -> (
            match parse_settings text with
            | Ok settings -> (settings, None)
            | Error reason -> ignored reason))
  in
  let overridden name file =
    match file with Some _ -> file | None -> getenv name
  in
  ( (function
    | "MESH_UPDATE_CHECK" -> overridden "MESH_UPDATE_CHECK" settings.check
    | "MESH_UPDATE_NOTICE" -> overridden "MESH_UPDATE_NOTICE" settings.notice
    | name -> getenv name),
    problem )

let check ~getenv ~installation ~request ~force ~now ~fetch =
  let level, note = level getenv in
  if getenv "MESH_UPDATE_CHECK" = Some "0" || level = C.Off then (Disabled, note)
  else
    match (installation, cache_path getenv) with
    | None, _ -> (Unknown_version, note)
    | _, None ->
        (Unavailable, Some "no cache directory (MESH_CACHE_DIR or HOME)")
    | Some installation, Some cache_path -> (
        let cache, error =
          if request then C.refresh ~now ~force ~cache_path ~fetch
          else (C.read_cache cache_path, None)
        in
        let error = match error with Some _ -> error | None -> note in
        match cache with
        | None -> (Unavailable, error)
        | Some cache -> (
            match
              C.announce level ~current:installation.version cache.releases
            with
            | Some notice -> (Available { notice; installation }, error)
            | None -> (Current, error)))

(* ---- the request *)

let read_file path = In_channel.with_open_bin path In_channel.input_all

(* The ETag of the last response in a -D dump (a proxy may add a block). *)
let header_etag text =
  String.split_on_char '\n' text
  |> List.fold_left
       (fun found line ->
         let line = String.trim line in
         if String.length line >= 5 && String.sub line 0 5 = "HTTP/" then None
         else
           match String.index_opt line ':' with
           | Some index
             when String.lowercase_ascii (String.sub line 0 index) = "etag" ->
               Some
                 (String.trim
                    (String.sub line (index + 1)
                       (String.length line - index - 1)))
           | _ -> found)
       None

(* [-q] is the first argument, the only place where curl honours it: without it
   a ~/.curlrc (an Authorization header, --netrc, a proxy) would change the
   request. The User-Agent is fixed and carries no version, host or user data. *)
let user_agent = "session-mesh-update-check"

let curl_arguments ?(url = releases_url) ~etag ~headers ~body () =
  let conditional =
    match etag with
    | Some etag when C.valid_etag etag -> [ "-H"; "If-None-Match: " ^ etag ]
    | _ -> []
  in
  [
    "curl";
    "-q";
    "-A";
    user_agent;
    "--proto";
    "=https";
    "--silent";
    "--connect-timeout";
    "10";
    "--max-time";
    "20";
    "--max-filesize";
    "4000000";
    "-H";
    "Accept: application/vnd.github+json";
    "-H";
    "X-GitHub-Api-Version: 2022-11-28";
  ]
  @ conditional
  @ [ "-D"; headers; "-o"; body; "-w"; "%{http_code}"; url ]

let run_curl arguments =
  let null = Unix.openfile "/dev/null" [ Unix.O_RDWR; Unix.O_CLOEXEC ] 0 in
  let reader, writer = Unix.pipe ~cloexec:true () in
  let pid =
    Fun.protect
      ~finally:(fun () ->
        Unix.close writer;
        Unix.close null)
      (fun () ->
        Unix.create_process "curl" (Array.of_list arguments) null writer null)
  in
  let status_line =
    Fun.protect
      ~finally:(fun () -> Unix.close reader)
      (fun () -> In_channel.input_all (Unix.in_channel_of_descr reader))
  in
  let rec wait () =
    match Unix.waitpid [] pid with
    | _, status -> status
    | exception Unix.Unix_error (Unix.EINTR, _, _) -> wait ()
  in
  (wait (), String.trim status_line)

(* The request's two working files live in the cache directory (a private
   0700 directory the check already owns), never in /tmp, and a killed process
   leaves them behind: they are removed once they are older than any request
   can last. *)
let work_prefix = "update-fetch."
let stale_after = 600.

let clean_stale ~directory =
  let now = Unix.time () in
  let stale name =
    (String.starts_with ~prefix:work_prefix name
    || String.starts_with ~prefix:"update-check.json." name
       && String.ends_with ~suffix:".tmp" name)
    &&
    match Unix.lstat (Filename.concat directory name) with
    | stat -> stat.Unix.st_kind = Unix.S_REG && now -. stat.Unix.st_mtime > stale_after
    | exception Unix.Unix_error _ -> false
  in
  match Sys.readdir directory with
  | names ->
      Array.iter
        (fun name ->
          if stale name then
            try Sys.remove (Filename.concat directory name)
            with Sys_error _ -> ())
        names
  | exception Sys_error _ -> ()

let fetch_with ~run ~directory ~etag =
  match
    C.make_directory directory;
    clean_stale ~directory;
    ( Filename.temp_file ~temp_dir:directory work_prefix ".headers",
      Filename.temp_file ~temp_dir:directory work_prefix ".json" )
  with
  | exception (Sys_error message) -> C.Failed message
  | exception Unix.Unix_error (error, call, _) ->
      C.Failed (Printf.sprintf "%s: %s" call (Unix.error_message error))
  | headers, body ->
      Fun.protect
        ~finally:(fun () ->
          List.iter
            (fun path -> try Sys.remove path with Sys_error _ -> ())
            [ headers; body ])
        (fun () ->
          match run (curl_arguments ~etag ~headers ~body ()) with
          | Unix.WEXITED 0, "200" -> (
              match (read_file headers, read_file body) with
              | headers_text, body_text ->
                  C.Body { etag = header_etag headers_text; body = body_text }
              | exception Sys_error message -> C.Failed message)
          | Unix.WEXITED 0, "304" -> C.Not_modified
          | Unix.WEXITED 0, code -> C.Failed ("HTTP status " ^ code)
          | Unix.WEXITED code, _ ->
              C.Failed (Printf.sprintf "curl exited with %d" code)
          | (Unix.WSIGNALED _ | Unix.WSTOPPED _), _ ->
              C.Failed "curl was killed"
          | exception Unix.Unix_error (error, call, _) ->
              C.Failed (Printf.sprintf "%s: %s" call (Unix.error_message error))
          | exception Sys_error message -> C.Failed message)

let curl_fetch ~directory ~etag = fetch_with ~run:run_curl ~directory ~etag
let cache_directory getenv = Option.map Filename.dirname (cache_path getenv)

let curl_fetch_in_cache getenv ~etag =
  match cache_directory getenv with
  | Some directory -> curl_fetch ~directory ~etag
  | None -> C.Failed "no cache directory (MESH_CACHE_DIR or HOME)"

(* ---- what is reported *)

let upgrade_command ~home ~tag installation =
  let script =
    Filename.concat (Filename.concat installation.share "current") "install.sh"
  in
  let shown =
    match home with
    | Some home
      when home <> "" && String.starts_with ~prefix:(home ^ "/") script ->
        "~"
        ^ String.sub script (String.length home)
            (String.length script - String.length home)
    | _ -> script
  in
  shown ^ " --upgrade --to " ^ tag

let status_name = function
  | Disabled -> "disabled"
  | Unknown_version -> "unknown-version"
  | Unavailable -> "unavailable"
  | Current -> "current"
  | Available _ -> "available"

let line ~home = function
  | Available { notice; installation } ->
      Some
        (Printf.sprintf
           "Session Mesh %s is available%s (running %s): %s. Upgrade with: %s"
           notice.latest.tag
           (if notice.security then ", with a security fix" else "")
           installation.tag
           (notes_url notice.latest.tag)
           (upgrade_command ~home ~tag:notice.latest.tag installation))
  | _ -> None

let to_json ~home outcome =
  let details =
    match (outcome, line ~home outcome) with
    | Available { notice; installation }, Some text ->
        [
          ("current", `String installation.tag);
          ("latest", `String notice.latest.tag);
          ("security", `Bool notice.security);
          ("notes_url", `String (notes_url notice.latest.tag));
          ("upgrade_command", `String (upgrade_command ~home ~tag:notice.latest.tag installation));
          ("line", `String text);
        ]
    | _ -> []
  in
  `Assoc (("status", `String (status_name outcome)) :: details)
