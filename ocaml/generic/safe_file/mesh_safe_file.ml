(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type error = Missing | Not_regular | Changed | Unreadable of string

let error_message = function
  | Missing -> "no such file"
  | Not_regular -> "not a regular file"
  | Changed -> "replaced while it was opened"
  | Unreadable message -> message

let system_error = function
  | Unix.ENOENT | Unix.ENOTDIR -> Missing
  | Unix.ELOOP -> Not_regular
  | error -> Unreadable (Unix.error_message error)

let same_file (a : Unix.stats) (b : Unix.stats) =
  a.st_dev = b.st_dev && a.st_ino = b.st_ino

let check_descriptor fd ~(seen : Unix.stats) =
  match Unix.fstat fd with
  | exception Unix.Unix_error (error, _, _) -> Error (system_error error)
  | opened when opened.Unix.st_kind <> Unix.S_REG -> Error Not_regular
  | opened when not (same_file opened seen) -> Error Changed
  | opened -> Ok (fd, opened)

let open_regular path =
  match Unix.lstat path with
  | exception Unix.Unix_error (error, _, _) -> Error (system_error error)
  | seen when seen.Unix.st_kind <> Unix.S_REG -> Error Not_regular
  | seen -> (
      match
        Unix.openfile path [ Unix.O_RDONLY; Unix.O_NONBLOCK; Unix.O_CLOEXEC; Unix.O_NOCTTY ] 0
      with
      | exception Unix.Unix_error (error, _, _) -> Error (system_error error)
      | fd ->
          let checked = check_descriptor fd ~seen in
          if Result.is_error checked then Unix.close fd;
          checked)

let with_regular path f =
  Result.map
    (fun (fd, stats) -> Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> f fd stats))
    (open_regular path)

let rec read_at fd ~offset bytes ~pos ~len =
  match
    ignore (Unix.lseek fd offset Unix.SEEK_SET : int);
    Unix.read fd bytes pos len
  with
  | count -> count
  | exception Unix.Unix_error (Unix.EINTR, _, _) -> read_at fd ~offset bytes ~pos ~len

let read_range fd ~offset ~length =
  let bytes = Bytes.create (max 0 length) in
  let rec fill filled =
    if filled >= length then filled
    else
      match read_at fd ~offset:(offset + filled) bytes ~pos:filled ~len:(length - filled) with
      | 0 -> filled
      | count -> fill (filled + count)
  in
  Bytes.sub_string bytes 0 (fill 0)
