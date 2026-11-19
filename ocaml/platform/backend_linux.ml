(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Linux backend: pure OCaml over procfs, no C stubs. *)

open Types

let ( let* ) = Result.bind

let error_of_unix_error code what =
  match code with
  | Unix.ENOENT | Unix.ESRCH -> Error Types.Not_found
  | Unix.EACCES | Unix.EPERM -> Error Denied
  | other -> Error (Malformed (what ^ ": " ^ Unix.error_message other))

(* Run [action]; map a Unix error to a platform error. *)
let guard what action =
  try action ()
  with Unix.Unix_error (code, _, _) -> error_of_unix_error code what

(* procfs reports st_size 0, so read until end of file. *)
let read_whole_file path =
  guard path (fun () ->
      let descriptor =
        Support.retry_on_eintr (fun () ->
            Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0)
      in
      Fun.protect
        ~finally:(fun () -> Support.close_quietly descriptor)
        (fun () ->
          let contents = Buffer.create 4096 in
          let chunk = Bytes.create 4096 in
          let rec loop () =
            let count =
              Support.retry_on_eintr (fun () ->
                  Unix.read descriptor chunk 0 (Bytes.length chunk))
            in
            if count > 0 then (
              Buffer.add_subbytes contents chunk 0 count;
              loop ())
          in
          loop ();
          Ok (Buffer.contents contents)))

let proc_path pid leaf = Printf.sprintf "/proc/%d/%s" pid leaf

let process pid =
  let* contents = read_whole_file (proc_path pid "stat") in
  Parse.linux_stat contents

let command_line pid =
  let* contents = read_whole_file (proc_path pid "cmdline") in
  Ok (Parse.linux_cmdline contents)

let working_directory pid =
  let path = proc_path pid "cwd" in
  guard path (fun () -> Ok (Unix.readlink path))

let foreground_process_group pid =
  let* found = process pid in
  Parse.foreground_group found.tpgid

(* Entries of [directory], or the mapped error. *)
let list_directory directory =
  guard directory (fun () ->
      let handle = Unix.opendir directory in
      Fun.protect
        ~finally:(fun () -> Support.closedir_quietly handle)
        (fun () ->
          let rec loop acc =
            match Unix.readdir handle with
            | name -> loop (name :: acc)
            | exception End_of_file -> List.rev acc
          in
          Ok (loop [])))

(* A descriptor that vanished, or one we may not read, is skipped. *)
let fd_target pid fd_name =
  match (int_of_string_opt fd_name, proc_path pid ("fd/" ^ fd_name)) with
  | None, _ -> None
  | Some fd, link -> (
      match Unix.readlink link with
      | target when String.length target > 0 && target.[0] = '/' ->
          Some (fd, target)
      | _ -> None
      | exception Unix.Unix_error _ -> None)

let open_file_paths pid =
  let* names = list_directory (proc_path pid "fd") in
  Ok (List.filter_map (fd_target pid) names |> List.sort compare)

(* procfs gives [/proc/<pid>] the process's real user id as its owner. *)
let process_owner pid =
  let path = Printf.sprintf "/proc/%d" pid in
  guard path (fun () -> Ok (Unix.stat path).Unix.st_uid)

let scan () =
  let* names = list_directory "/proc" in
  Support.collect_scan names process

(* Unreadable means an error, never "not bound": the caller decides. *)
let unix_socket_bound path =
  let* contents = read_whole_file "/proc/net/unix" in
  Ok (Parse.linux_unix_socket_bound contents path)

let is_executable_file path =
  match Unix.stat path with
  | { Unix.st_kind = Unix.S_REG; _ } -> (
      try
        Unix.access path [ Unix.X_OK ];
        true
      with Unix.Unix_error _ -> false)
  | _ -> false
  | exception Unix.Unix_error _ -> false

let capabilities () =
  {
    process_table = true;
    foreground_agent = true;
    open_file_paths = true;
    isolated_agent = is_executable_file "/usr/bin/setpriv";
    demo_sandbox = is_executable_file "/usr/bin/bwrap";
  }
