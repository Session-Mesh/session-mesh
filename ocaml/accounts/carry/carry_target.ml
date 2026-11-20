(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The target account folder before anything is written: its folders, the
   lock that keeps two carries of one conversation apart, what a killed carry
   left there, and the free space of its file system. *)

open Carry_base

external free_bytes_raw : string -> int = "mesh_accounts_carry_free_bytes"

(* The bytes still available on the file system of [path]; [None] when
   statvfs fails. *)
let free_bytes path =
  let bytes = free_bytes_raw path in
  if bytes < 0 then None else Some bytes

(* The folders of [relative]'s path in the target are private folders of the
   operator's, or missing (they are then created). *)
let check_folders ~uid ~target relative =
  List.fold_left
    (fun acc folder ->
      let* () = acc in
      let* stats = lstat_opt (join target folder) in
      match stats with
      | None -> Ok ()
      | Some stats -> private_folder ~uid ("target " ^ folder) stats)
    (Ok ()) (parents relative)

(* ------------------------------------------------------------- the lock *)

let lock_name = ".mesh-carry.lock"
let open_flags = [ Unix.O_RDWR; Unix.O_CLOEXEC; Unix.O_NONBLOCK ]

let lock_failure error =
  fail "carry_failed" ("the lock file: " ^ Unix.error_message error)

let same_file (a : Unix.stats) (b : Unix.stats) =
  a.st_dev = b.st_dev && a.st_ino = b.st_ino

(* An existing lock file: a regular file of the operator's, 0600 at most,
   with no other name, opened as the one lstat saw. *)
let open_existing_lock ~uid path =
  match Unix.lstat path with
  | exception Unix.Unix_error (error, _, _) -> lock_failure error
  | seen
    when seen.st_kind <> Unix.S_REG || seen.st_uid <> uid || seen.st_nlink <> 1
         || seen.st_perm land 0o077 <> 0 ->
      fail "unsafe_entry" (lock_name ^ " is not a private regular file")
  | seen -> (
      match Unix.openfile path open_flags 0 with
      | exception Unix.Unix_error (error, _, _) -> lock_failure error
      | descriptor -> (
          match Unix.fstat descriptor with
          | opened when same_file seen opened -> Ok descriptor
          | _ | (exception Unix.Unix_error _) ->
              Unix.close descriptor;
              fail "unsafe_entry" (lock_name ^ " changed while it was opened")))

let open_lock ~uid ~target =
  let path = join target lock_name in
  match
    Unix.openfile path (Unix.O_CREAT :: Unix.O_EXCL :: open_flags) 0o600
  with
  | descriptor -> Ok descriptor
  | exception Unix.Unix_error (Unix.EEXIST, _, _) ->
      open_existing_lock ~uid path
  | exception Unix.Unix_error (error, _, _) -> lock_failure error

(* Run [f] holding an exclusive lock, without waiting, on the byte of
   [target]/.mesh-carry.lock that the conversation's hash picks: two carries
   of one conversation into one folder never overlap, carries of other
   conversations go on. The lock is an fcntl lock, between processes; it ends
   with the process. The file stays. *)
let with_lock ~uid ~target conversation f =
  let* descriptor = open_lock ~uid ~target in
  Fun.protect
    ~finally:(fun () -> quietly (fun () -> Unix.close descriptor))
    (fun () ->
      match
        ignore (Unix.lseek descriptor (Hashtbl.hash conversation) Unix.SEEK_SET);
        Unix.lockf descriptor Unix.F_TLOCK 1
      with
      | () -> f ()
      | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EACCES), _, _) ->
          fail "carry_in_progress"
            "a carry of this conversation into this account is already in \
             progress"
      | exception Unix.Unix_error (error, _, _) -> lock_failure error)

(* -------------------------------------------------- a killed carry's files *)

type leftover = { path : string; base : string; tag : string; mtime : float }

(* The carry temporaries of the files [bases] in [folder], regular files of
   the operator's only. *)
let leftovers ~uid folder bases =
  let* names = readdir folder in
  Ok
    (List.filter_map
       (fun name ->
         match carry_temporary name with
         | Some (base, tag) when List.mem base bases -> (
             let path = join folder name in
             match Unix.lstat path with
             | { Unix.st_kind = Unix.S_REG; st_uid; st_mtime; _ }
               when st_uid = uid ->
                 Some { path; base; tag; mtime = st_mtime }
             | _ | (exception Unix.Unix_error _) -> None)
         | _ -> None)
       names)

(* A new temporary is removed. An old one is a copy put aside by a
   replacement: the newest goes back in place when the file itself is
   missing; the others are removed. *)
let settle folder found base =
  let mine = List.filter (fun leftover -> leftover.base = base) found in
  let olds =
    List.sort
      (fun a b -> compare b.mtime a.mtime)
      (List.filter (fun leftover -> leftover.tag = "old") mine)
  in
  List.iter
    (fun leftover -> if leftover.tag = "new" then Unix.unlink leftover.path)
    mine;
  let final = join folder base in
  let missing =
    match Unix.lstat final with
    | _ -> false
    | exception Unix.Unix_error (Unix.ENOENT, _, _) -> true
  in
  match olds with
  | newest :: rest when missing ->
      Unix.rename newest.path final;
      List.iter (fun leftover -> Unix.unlink leftover.path) rest
  | _ -> List.iter (fun leftover -> Unix.unlink leftover.path) olds

(* Before a carry, under its lock: the temporary files a killed carry left
   next to the files about to be written ([.<name>.carry-new-<16 hex>] and
   [.<name>.carry-old-<16 hex>] exactly, nothing else). The folders were
   checked by {!check_folders}. *)
let clean_leftovers ~uid ~target relatives =
  let folders = List.sort_uniq compare (List.map Filename.dirname relatives) in
  let bases_in folder =
    List.filter_map
      (fun relative ->
        if Filename.dirname relative = folder then
          Some (Filename.basename relative)
        else None)
      relatives
  in
  List.fold_left
    (fun acc folder ->
      let* () = acc in
      let full = join target folder in
      let* present = lstat_opt full in
      if present = None then Ok ()
      else
        let bases = bases_in folder in
        let* found = leftovers ~uid full bases in
        match List.iter (settle full found) bases with
        | () -> Ok ()
        | exception Unix.Unix_error (error, _, _) ->
            fail "carry_failed"
              ("a killed carry's files could not be removed: "
             ^ Unix.error_message error))
    (Ok ()) folders
