(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The preset and catalogue checks under test refuse a fixture when any
   directory above it is writable by group or others, unless root owns that
   directory and it is sticky. The default temporary directory cannot be
   assumed to satisfy that: dune gives a test its own TMPDIR, created with mode
   0777 minus the caller's umask, hence 0775 under Ubuntu's default 0002.

   A test therefore asks for a directory created here with mode 0700, under
   the nearest directory at or above the temporary directory whose whole
   chain up to / satisfies the rule below. The rule is written here on
   purpose rather than borrowed from the code under test. *)

let trusted_directory path =
  match Unix.lstat path with
  | exception Unix.Unix_error _ -> false
  | stat ->
      let root_owned = stat.Unix.st_uid = 0 in
      let writable_by_others = stat.st_perm land 0o022 <> 0 in
      let sticky = stat.st_perm land 0o1000 <> 0 in
      stat.st_kind = Unix.S_DIR
      && (root_owned || stat.st_uid = Unix.geteuid ())
      && ((not writable_by_others) || (root_owned && sticky))

let rec trusted_chain path =
  trusted_directory path && (path = "/" || trusted_chain (Filename.dirname path))

let writable path =
  match Unix.access path [ Unix.W_OK; Unix.X_OK ] with
  | () -> true
  | exception Unix.Unix_error _ -> false

let rec nearest_trusted_parent path =
  if trusted_chain path && writable path then path
  else if path = "/" then
    failwith
      "test scratch: no writable directory at or above the temporary directory \
       has ancestors that only this user or root can write"
  else nearest_trusted_parent (Filename.dirname path)

(* A host socket sits a few components below a test's scratch directory and
   its path must fit sun_path (103 bytes on macOS). The default macOS
   temporary directory (under /private/var/folders, longer still under dune)
   leaves no room, so a longer temporary directory is replaced by /tmp. *)
let max_temp_root = 40

let short_temp_root () =
  let given = Unix.realpath (Filename.get_temp_dir_name ()) in
  if String.length given <= max_temp_root then given else Unix.realpath "/tmp"

let private_directory prefix =
  let parent = nearest_trusted_parent (short_temp_root ()) in
  let directory = Filename.temp_dir ~temp_dir:parent ~perms:0o700 prefix "" in
  Unix.chmod directory 0o700;
  directory

let executable_file path =
  match Unix.stat path with
  | exception Unix.Unix_error _ -> false
  | stat -> (
      stat.Unix.st_kind = Unix.S_REG
      &&
      try
        Unix.access path [ Unix.X_OK ];
        true
      with Unix.Unix_error _ -> false)

let node () =
  let path = Option.value ~default:"" (Sys.getenv_opt "PATH") in
  let candidates =
    List.filter_map
      (fun directory ->
        if directory = "" then None else Some (Filename.concat directory "node"))
      (String.split_on_char ':' path)
  in
  match List.find_opt executable_file candidates with
  | Some found -> Unix.realpath found
  | None -> failwith "test scratch: no executable node on PATH"
