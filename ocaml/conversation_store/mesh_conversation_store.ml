(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type source =
  | Missing
  | Contents of string
  | Unreadable of Unix.error

exception Parent_exited

(* Unix represents descriptors as integers on both supported platforms. The
   inherited descriptor is checked against its pipe identity before use. *)
external descriptor_of_int : int -> Unix.file_descr = "%identity"

(* Only the server's one-shot subprocess supplies the pipe. The server owns
   its write end, so EOF means the original caller is gone, even through a
   non-exec wrapper. An absent/replaced descriptor must fail closed. *)
let parent_guard () =
  match Sys.getenv_opt "MESH_CONVERSATION_LIFELINE" with
  | None -> ignore
  | Some value ->
      let number, device, inode =
        match String.split_on_char ':' value with
        | [number; device; inode] -> (
            match int_of_string_opt number, int_of_string_opt device, int_of_string_opt inode with
            | Some number, Some device, Some inode when number > 2 -> number, device, inode
            | _ -> raise Parent_exited)
        | _ -> raise Parent_exited
      in
      let matches number =
        try
          let stat = Unix.fstat (descriptor_of_int number) in
          stat.st_kind = Unix.S_FIFO && stat.st_dev = device && stat.st_ino = inode
        with Unix.Unix_error _ -> false
      in
      (* Some wrappers move inherited descriptors. Check the original number
         first; only scan when a wrapper changed it, matching the pipe itself
         rather than trusting any unrelated descriptor with the same number. *)
      let rec find number =
        if number > 4095 then raise Parent_exited
        else if matches number then number else find (number + 1)
      in
      let fd = descriptor_of_int (if matches number then number else find 3) in
      (try
         Unix.set_nonblock fd;
         Unix.set_close_on_exec fd
       with Unix.Unix_error _ -> raise Parent_exited);
      let byte = Bytes.create 1 in
      let rec check () =
        match Unix.read fd byte 0 1 with
        | _ -> raise Parent_exited
        | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) -> ()
        | exception Unix.Unix_error (Unix.EINTR, _, _) -> check ()
        | exception Unix.Unix_error _ -> raise Parent_exited
      in
      check

(* Reuse the BSD flock binding linked by mesh_worklog. Unix.lockf takes a
   different lock on Linux, so it cannot coordinate with the existing writer. *)
external flock_try : Unix.file_descr -> bool = "mesh_worklog_flock_try"

let rec acquire check_parent fd =
  check_parent ();
  if not (flock_try fd) then (
    Unix.sleepf 0.005;
    acquire check_parent fd)

let rec mkdir_parents path =
  match Unix.mkdir path 0o777 with
  | () -> ()
  | exception Unix.Unix_error (Unix.EEXIST, _, _) ->
      if not (Sys.is_directory path) then
        raise (Unix.Unix_error (Unix.ENOTDIR, "mkdir", path))
  | exception Unix.Unix_error (Unix.ENOENT, _, _) ->
      mkdir_parents (Filename.dirname path);
      mkdir_parents path

let read path =
  match Unix.openfile path [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 with
  | fd ->
      (try
         Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
             let data = Buffer.create 4096 in
             let chunk = Bytes.create 4096 in
             let rec read_all () =
               match Unix.read fd chunk 0 (Bytes.length chunk) with
               | 0 -> Contents (Buffer.contents data)
               | size ->
                   Buffer.add_subbytes data chunk 0 size;
                   read_all ()
               | exception Unix.Unix_error (Unix.EINTR, _, _) -> read_all ()
             in
             read_all ())
       with Unix.Unix_error (error, _, _) -> Unreadable error)
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Missing
  | exception Unix.Unix_error (error, _, _) -> Unreadable error

let replace ~check_parent path data =
  let tmp, out =
    Filename.open_temp_file ~mode:[Open_binary] ~perms:0o600
      ~temp_dir:(Filename.dirname path) ("." ^ Filename.basename path ^ ".") ""
  in
  try
    let fd = Unix.descr_of_out_channel out in
    Unix.set_close_on_exec fd;
    Unix.fchmod fd 0o600;
    output_string out data;
    flush out;
    Unix.fsync fd;
    close_out out;
    check_parent ();
    Unix.rename tmp path
  with exn ->
    close_out_noerr out;
    (try Unix.unlink tmp with Unix.Unix_error _ -> ());
    raise exn

let transact_then ~path f =
  let check_parent = parent_guard () in
  check_parent ();
  let lock = Filename.remove_extension path ^ ".lock" in
  mkdir_parents (Filename.dirname path);
  let fd = Unix.openfile lock [Unix.O_WRONLY; Unix.O_APPEND; Unix.O_CREAT; Unix.O_CLOEXEC] 0o666 in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
      acquire check_parent fd;
      check_parent ();
      let after_write, replacement = f (read path) in
      Option.iter (replace ~check_parent path) replacement;
      after_write ())

let transact ~path f =
  transact_then ~path (fun source ->
      let result, replacement = f source in
      (fun () -> result), replacement)
