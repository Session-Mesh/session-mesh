(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Runtime directory resolution and validation. The platform facts are
   parameters so the logic stays testable; [Mesh_platform] supplies real ones. *)

open Types

let ( let* ) = Result.bind
let socket_relative = Filename.concat "session-mesh" "ptyhost.sock"
let socket_path { path; _ } = Filename.concat path socket_relative
let max_socket_path = function Linux -> 107 | Macos | Other _ -> 103

let env_nonempty getenv name =
  match getenv name with Some "" | None -> None | Some value -> Some value

let reject variable fmt =
  Printf.ksprintf (fun reason -> Error (variable ^ ": " ^ reason)) fmt

let check_absolute variable path =
  if Filename.is_relative path then
    reject variable "%S is not an absolute path" path
  else Ok ()

(* No trailing slash, no empty segment, no "." or ".." segment. A trailing "/"
   or "/." would otherwise make lstat follow a final symlink. *)
let is_normalised path =
  match String.split_on_char '/' path with
  | "" :: (_ :: _ as segments) ->
      List.for_all
        (fun segment -> segment <> "" && segment <> "." && segment <> "..")
        segments
  | _ -> false

let check_normalised variable path =
  if is_normalised path then Ok ()
  else
    reject variable
      "%S is not a normalised absolute path (no trailing slash, empty, \".\" \
       or \"..\" segment)"
      path

let check_directory variable ~euid ~exact_private path =
  match Unix.lstat path with
  | exception Unix.Unix_error (code, _, _) ->
      reject variable "cannot inspect %S: %s" path (Unix.error_message code)
  | { Unix.st_kind = Unix.S_DIR; st_uid; st_perm; _ } ->
      if st_uid <> euid then
        reject variable "%S is owned by uid %d, not by uid %d" path st_uid euid
      else if st_perm land 0o022 <> 0 then
        reject variable "%S is writable by group or others (mode %04o)" path
          st_perm
      else if exact_private && st_perm <> 0o700 then
        reject variable "%S has mode %04o, not 0700" path st_perm
      else Ok ()
  | { Unix.st_kind = Unix.S_LNK; _ } ->
      reject variable "%S is a symbolic link, not a directory" path
  | _ -> reject variable "%S is not a directory" path

(* Resolves every symlink, ancestors included: the value must already be the
   canonical path. *)
let check_canonical variable path =
  match Unix.realpath path with
  | exception Unix.Unix_error (code, _, _) ->
      reject variable "cannot resolve %S: %s" path (Unix.error_message code)
  | resolved when resolved = path -> Ok ()
  | resolved ->
      reject variable "%S is not canonical: it resolves to %S (symbolic link)"
        path resolved

let check_socket_fits variable ~max_length candidate =
  let length = String.length (socket_path candidate) in
  if length > max_length then
    reject variable "socket path %S is %d bytes, over the %d byte limit"
      (socket_path candidate) length max_length
  else Ok ()

(* [exact_private]: the mode must be literally 0700, setuid, setgid and sticky
   bits included; read from the same lstat as the other directory checks. *)
let validate ?(exact_private = false) variable ~platform ~euid candidate_path
    source =
  let* () = check_absolute variable candidate_path in
  let* () = check_normalised variable candidate_path in
  let* () = check_directory variable ~euid ~exact_private candidate_path in
  let* () = check_canonical variable candidate_path in
  let candidate = { path = candidate_path; source } in
  let* () =
    check_socket_fits variable ~max_length:(max_socket_path platform) candidate
  in
  Ok candidate

let unset_message =
  "neither MESH_RUNTIME_DIR nor XDG_RUNTIME_DIR is set; set MESH_RUNTIME_DIR \
   to a directory owned by you and not writable by group or others"

(* Linux only, and only when both variables are unset: /run/user/<euid>. A
   rejected guess is reported with the variables to set, so the error says
   both what was tried and how to fix it. *)
let guess_run_user ~run_user_root ~platform ~euid =
  let path = Filename.concat run_user_root (string_of_int euid) in
  let variable = path ^ " (guessed)" in
  (* logind creates the directory with exactly mode 0700; a guess is held to
     that stricter mode on top of every check an explicit variable gets. *)
  match
    validate ~exact_private:true variable ~platform ~euid path Run_user_guess
  with
  | Ok _ as accepted -> accepted
  | Error reason -> Error (unset_message ^ "; " ^ reason)

(* macOS default: [<home>/Library/Application Support/session-mesh/run], where
   [home] is the passwd home of the effective user (not [$HOME], so that a
   client run with another [HOME] still finds the socket; the installer and
   Python client ptyhost.py use the same passwd entry). Application Support is Apple's
   per-user location that the system does not purge, unlike the per-user
   temporary directory. [Library/Application Support] must already exist (it
   does on every macOS account); [session-mesh] and [run] are created with mode
   0700 when missing. [mkdir] never follows a symlink at its last component, and
   each created component is then checked with [lstat] (a directory, owned, not
   group- or other-writable) before the next one is made. *)
let macos_parent = Filename.concat "Library" "Application Support"
let macos_created = [ "session-mesh"; "run" ]

let macos_default_path home =
  List.fold_left Filename.concat
    (Filename.concat home macos_parent)
    macos_created

let set_variable_hint = "; set MESH_RUNTIME_DIR to a private directory"

let check_existing_parent variable path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; _ } -> Ok ()
  | _ -> reject variable "%S is not a directory" path
  | exception Unix.Unix_error (code, _, _) ->
      reject variable "cannot use %S: %s" path (Unix.error_message code)

let make_private_dir variable ~euid path =
  match Unix.mkdir path 0o700 with
  | () | (exception Unix.Unix_error (Unix.EEXIST, _, _)) ->
      check_directory variable ~euid ~exact_private:false path
  | exception Unix.Unix_error (code, _, _) ->
      reject variable "cannot create %S: %s" path (Unix.error_message code)

let create_macos_default variable ~euid home =
  let parent = Filename.concat home macos_parent in
  let* () = check_existing_parent variable parent in
  List.fold_left
    (fun previous name ->
      let* parent = previous in
      let path = Filename.concat parent name in
      let* () = make_private_dir variable ~euid path in
      Ok path)
    (Ok parent) macos_created

let guess_macos_default ~home ~platform ~euid =
  match home () with
  | None | Some "" ->
      Error
        (Printf.sprintf
           "%s; no home directory is known for uid %d to place the macOS \
            default runtime directory"
           unset_message euid)
  | Some home ->
      let path = macos_default_path home in
      let variable = path ^ " (macOS default)" in
      let* () =
        Result.map_error
          (fun reason ->
            reason ^ "; set MESH_RUNTIME_DIR to a shorter directory")
          (check_socket_fits variable ~max_length:(max_socket_path platform)
             { path; source = Macos_default })
      in
      Result.map_error
        (fun reason -> reason ^ set_variable_hint)
        (let* _created = create_macos_default variable ~euid home in
         validate variable ~platform ~euid path Macos_default)

let resolve ~getenv ~home ~run_user_root ~platform ~euid =
  match
    ( env_nonempty getenv "MESH_RUNTIME_DIR",
      env_nonempty getenv "XDG_RUNTIME_DIR" )
  with
  | Some path, _ ->
      validate "MESH_RUNTIME_DIR" ~platform ~euid path Mesh_runtime_dir
  | None, Some path ->
      validate "XDG_RUNTIME_DIR" ~platform ~euid path Xdg_runtime_dir
  | None, None -> (
      match platform with
      | Linux -> guess_run_user ~run_user_root ~platform ~euid
      | Macos -> guess_macos_default ~home ~platform ~euid
      | Other _ -> Error unset_message)
