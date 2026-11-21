(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let rec mkdir_p dir =
  if dir <> "" && dir <> "/" && dir <> "." && not (Sys.file_exists dir) then begin
    mkdir_p (Filename.dirname dir);
    try Unix.mkdir dir 0o755 with Unix.Unix_error (Unix.EEXIST, _, _) -> ()
  end

let size path =
  match Safefs.open_regular path [ Unix.O_RDONLY ] with
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> None
  | fd ->
      Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> Some (Unix.fstat fd).Unix.st_size)

let read_range path ~pos ~len =
  let fd = Safefs.open_regular path [ Unix.O_RDONLY ] in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      ignore (Unix.lseek fd pos Unix.SEEK_SET);
      let buf = Bytes.create len in
      let rec fill off =
        if off < len then
          match Unix.read fd buf off (len - off) with
          | 0 -> off
          | n -> fill (off + n)
        else off
      in
      Bytes.sub_string buf 0 (fill 0))

let last_byte_is_newline path =
  match size path with
  | None | Some 0 -> true
  | Some n -> read_range path ~pos:(n - 1) ~len:1 = "\n"

let tail path n =
  match size path with
  | None -> ""
  | Some len ->
      let pos = max 0 (len - n) in
      read_range path ~pos ~len:(len - pos)

let rec write_all fd s off =
  if off < String.length s then
    let written = Unix.single_write_substring fd s off (String.length s - off) in
    write_all fd s (off + written)

let write_durably fd blob =
  write_all fd blob 0;
  Unix.fsync fd

(* The last byte of the file behind an [O_RDWR | O_APPEND] descriptor. *)
let ends_with_newline fd =
  let len = (Unix.fstat fd).Unix.st_size in
  len = 0
  ||
  let one = Bytes.create 1 in
  ignore (Unix.lseek fd (len - 1) Unix.SEEK_SET);
  Unix.read fd one 0 1 = 1 && Bytes.get one 0 = '\n'

(* A new file that appears whole or not at all: its bytes go to a temporary file of its own in the same
   directory, which is then linked to its name ([link] never replaces an existing name). A reader never sees
   it empty or cut short, and a write that fails leaves nothing under the name. *)
let create_whole ?root path content =
  Safefs.make_dirs ?root (Filename.dirname path);
  let staged =
    Printf.sprintf "%s.tmp.%d.%d" path (Unix.getpid ()) (Random.State.bits (Random.State.make_self_init ()))
  in
  let fd = Unix.openfile staged [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ] 0o644 in
  Fun.protect
    ~finally:(fun () -> try Unix.unlink staged with Unix.Unix_error _ -> ())
    (fun () ->
      Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> write_durably fd content);
      match Unix.link staged path with
      | () -> ()
      | exception Unix.Unix_error (Unix.EEXIST, _, _) -> Err.fail Err.Other ("file already exists: " ^ path))

let append ?root path blob =
  Safefs.make_dirs ?root (Filename.dirname path);
  let fd = Safefs.open_create path [ Unix.O_RDWR; Unix.O_APPEND ] in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let blob = if ends_with_newline fd then blob else "\n" ^ blob in
      write_durably fd blob)

let create_exclusive ?root path content =
  Safefs.make_dirs ?root (Filename.dirname path);
  match Unix.openfile path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ] 0o644 with
  | exception Unix.Unix_error (Unix.EEXIST, _, _) ->
      Err.fail Err.Other ("file already exists: " ^ path)
  | fd -> Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> write_durably fd content)
