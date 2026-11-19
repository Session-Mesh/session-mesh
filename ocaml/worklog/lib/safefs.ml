(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let refuse path why = Err.fail Err.Other (Printf.sprintf "%s: %s" path why)

let kind path =
  match Unix.lstat path with
  | st -> Some st.Unix.st_kind
  | exception Unix.Unix_error ((Unix.ENOENT | Unix.ENOTDIR), _, _) -> None

let is_regular_file path = kind path = Some Unix.S_REG
let is_real_dir path = kind path = Some Unix.S_DIR

let is_file_following path =
  match Unix.stat path with
  | st -> st.Unix.st_kind = Unix.S_REG
  | exception Unix.Unix_error _ -> false

let same_file (a : Unix.stats) (b : Unix.stats) = a.st_dev = b.st_dev && a.st_ino = b.st_ino

let refuse_if_special path =
  match kind path with
  | Some Unix.S_REG | None -> ()
  | Some _ -> refuse path "not a regular file (symbolic links and special files are refused)"

(* OCaml's [Unix] has no [O_NOFOLLOW]: the path is checked with [lstat] before it
   is opened (so an ordinary link, device or FIFO is never opened), opened with
   [O_NONBLOCK] (so one swapped in after the check cannot block), and checked
   again on the descriptor. *)
let open_regular path flags =
  refuse_if_special path;
  let fd = Unix.openfile path (Unix.O_CLOEXEC :: Unix.O_NONBLOCK :: flags) 0 in
  match (Unix.fstat fd, Unix.lstat path) with
  | opened, named
    when opened.Unix.st_kind = Unix.S_REG && named.Unix.st_kind = Unix.S_REG
         && same_file opened named ->
      fd
  | _ ->
      Unix.close fd;
      refuse path "not a regular file (symbolic links and special files are refused)"
  | exception e ->
      Unix.close fd;
      raise e

let open_create path flags =
  if kind path = None then begin
    match Unix.openfile path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ] 0o644 with
    | fd -> Unix.close fd
    | exception Unix.Unix_error (Unix.EEXIST, _, _) -> ()
  end;
  open_regular path flags

let max_read_bytes = 64 * 1024 * 1024
let max_taxonomy_bytes = 1024 * 1024

(* At most [limit] bytes; a longer file is refused, never truncated. *)
let read_descriptor ~limit path fd =
  let buf = Buffer.create 4096 and chunk = Bytes.create 65536 in
  let rec go () =
    match Unix.read fd chunk 0 (Bytes.length chunk) with
    | 0 -> Buffer.contents buf
    | n ->
        Buffer.add_subbytes buf chunk 0 n;
        if Buffer.length buf > limit then
          refuse path (Printf.sprintf "larger than the %d bytes this library reads" limit)
        else go ()
    | exception Unix.Unix_error (Unix.EINTR, _, _) -> go ()
  in
  go ()

let read_file ?(limit = max_read_bytes) path =
  let fd = open_regular path [ Unix.O_RDONLY ] in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> read_descriptor ~limit path fd)

(* A regular file, a link to one allowed: opened without blocking, then its type
   is checked on the descriptor. *)
let read_file_following ?(limit = max_read_bytes) path =
  let fd = Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC; Unix.O_NONBLOCK ] 0 in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
      if (Unix.fstat fd).Unix.st_kind <> Unix.S_REG then refuse path "not a regular file";
      read_descriptor ~limit path fd)

let read_file_result ?limit path =
  match read_file ?limit path with
  | text -> Ok text
  | exception Err.E e -> Error e.Err.message
  | exception Unix.Unix_error (code, _, _) -> Error (Unix.error_message code)
  | exception Sys_error why -> Error why

let list_dir path =
  if is_real_dir path then List.sort String.compare (Array.to_list (Sys.readdir path)) else []

let make_dir dir =
  match kind dir with
  | Some Unix.S_DIR -> ()
  | Some _ -> refuse dir "not a real directory (symbolic links are refused)"
  | None -> ( try Unix.mkdir dir 0o755 with Unix.Unix_error (Unix.EEXIST, _, _) -> ())

let components_below ~root dir =
  let rec up d acc =
    if d = root || d = "/" || d = "." || d = Filename.dirname d then acc
    else up (Filename.dirname d) (d :: acc)
  in
  up dir []

let strip_slashes s =
  let n = ref (String.length s) in
  while !n > 1 && s.[!n - 1] = '/' do decr n done;
  String.sub s 0 !n

(* Missing ancestors of a directory without a root: created as they are; only the
   directory itself is then checked. *)
let rec create_missing dir =
  if dir <> "" && dir <> "/" && dir <> "." && kind dir = None then begin
    create_missing (Filename.dirname dir);
    make_dir dir
  end

let make_dirs ?root dir =
  match root with
  | None ->
      create_missing dir;
      make_dir dir
  | Some root -> List.iter make_dir (components_below ~root:(strip_slashes root) dir)

let resolve_inside ~root path =
  let target = Unix.realpath path and base = Unix.realpath root in
  let prefix = base ^ "/" in
  let n = String.length prefix in
  if String.length target > n && String.sub target 0 n = prefix then target
  else
    Err.usage "%s resolves to %s, outside the data repository; refusing to use it" path target
