(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog

let pending : string list ref = ref []
let reset_warnings () = pending := []
let max_warning = 300

(* A message already reported in this call is not repeated. *)
let warn message =
  if List.length !pending < 20 then begin
    let message = Work_render.trunc ~max:max_warning (Work_err.safe_text message) in
    if not (List.mem message !pending) then pending := message :: !pending
  end

let take_warnings () =
  let w = List.rev !pending in
  pending := [];
  w

let non_empty = function Some "" | None -> None | Some v -> Some v

let home getenv =
  match non_empty (getenv "HOME") with
  | Some h -> Some h
  | None -> ( try Some (Unix.getpwuid (Unix.getuid ())).Unix.pw_dir with Not_found -> None)

(* Where the library would look first, for creating a repository at first
   use: WL_HOME ([~] and [~/..] expanded), else <home>/worklog-data. *)
let target_root getenv =
  let expand p =
    if p = "~" then home getenv
    else if String.length p > 2 && String.sub p 0 2 = "~/" then
      Option.map (fun h -> Filename.concat h (String.sub p 2 (String.length p - 2))) (home getenv)
    else if p <> "" && p.[0] = '~' then None
    else Some p
  in
  match non_empty (getenv "WL_HOME") with
  | Some p -> expand p
  | None -> Option.map (fun h -> Filename.concat h "worklog-data") (home getenv)

let is_directory path = match Unix.stat path with { Unix.st_kind = Unix.S_DIR; _ } -> true | _ -> false | exception Unix.Unix_error _ -> false

(* Only a path that does not exist, or an empty directory, is initialised, and
   a missing path only when its parent exists: a misspelt [WL_HOME] makes at
   most one directory, never a chain of them. *)
let can_init root =
  match Unix.lstat root with
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> is_directory (Filename.dirname root)
  | { Unix.st_kind = Unix.S_DIR; _ } -> ( try Sys.readdir root = [||] with Sys_error _ -> false)
  | _ -> false
  | exception Unix.Unix_error _ -> false

(* [None] when there was nothing to create or it was created; the error of the
   creation otherwise. *)
let init_first_use getenv =
  match target_root getenv with
  | Some root when can_init root -> ( match W.Init.init ~root () with Ok () -> None | Error e -> Some e)
  | _ -> None

(* Another server starting at the same moment may be in the middle of its own
   creation: the repository is read again a few times before giving up. That
   is only worth waiting for when the directory looks like a repository being
   created: it is empty, or it holds the [taxonomy.yaml] that [init] writes
   first (or a leftover of it) and not yet all of [.git], [tasks] and
   [events]. A directory that merely holds a [.git], [events] or [tasks] of
   something else fails at once. *)
let in_creation getenv =
  match target_root getenv with
  | None -> false
  | Some root -> (
      match Sys.readdir root with
      | exception Sys_error _ -> false
      | [||] -> true
      | names ->
          let has name = Array.mem name names in
          has "taxonomy.yaml.tmp"
          || (has "taxonomy.yaml" && not (has ".git" && has "tasks" && has "events")))

let read_again getenv =
  let rec go tries =
    match W.Ctx.of_env ~getenv ~warn () with
    | Ok ctx -> Ok ctx
    | Error _ when tries > 0 && in_creation getenv ->
        Unix.sleepf 0.1;
        go (tries - 1)
    | Error e -> Error e
  in
  go 20

let creation_failed (e : W.Err.t) =
  Work_err.debug_detail "repository" e.message;
  Work_err.make "repository"
    ("the data repository could not be created at first use: " ^ Work_err.sanitise e.message)

let context ?(getenv = Sys.getenv_opt) () =
  match W.Ctx.of_env ~getenv ~warn () with
  | Ok ctx -> Ok ctx
  | Error { W.Err.kind = W.Err.Repo; _ } as first -> (
      (* Init refuses an existing repository, so a race with another first
         use ends in the reads below. *)
      let creation = init_first_use getenv in
      match (read_again getenv, creation) with
      | Ok ctx, _ -> Ok ctx
      | Error _, Some e -> Error (creation_failed e)
      | Error _, None -> Result.map_error Work_err.of_worklog first)
  | Error e -> Error (Work_err.of_worklog e)
