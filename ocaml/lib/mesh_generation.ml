(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t = int

let file_name = "cookie-generation"

(* Decimal digits, single underscores between them (Python's int grammar);
   None on any other character or above max_int. *)
let digits_value text start =
  let length = String.length text in
  let rec loop i value previous_digit =
    if i = length then if previous_digit then Some value else None
    else
      match text.[i] with
      | '0' .. '9' as c ->
          let digit = Char.code c - Char.code '0' in
          if value > (max_int - digit) / 10 then None
          else loop (i + 1) ((value * 10) + digit) true
      | '_' when previous_digit -> loop (i + 1) value false
      | _ -> None
  in
  if start < length then loop start 0 false else None

let parse text =
  let text = Mesh_python_text.strip text in
  if text = "" then None
  else
    match text.[0] with
    | '+' -> digits_value text 1
    | '-' -> (
        match digits_value text 1 with
        | Some 0 -> Some 0
        | Some _ | None -> None)
    | _ -> digits_value text 0

let describe path error =
  Printf.sprintf "%s: %s" path (Unix.error_message error)

let rec write_all fd text offset =
  if offset < String.length text then
    let written =
      Unix.write_substring fd text offset (String.length text - offset)
    in
    write_all fd text (offset + written)

(* A new file beside [path], created exclusively at 0600. *)
let rec create_temporary path attempts =
  let name =
    Printf.sprintf ".%s.%08x" (Filename.basename path) (Random.bits ())
  in
  let temporary = Filename.concat (Filename.dirname path) name in
  match
    Unix.openfile temporary
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
      0o600
  with
  | fd -> (temporary, fd)
  | exception Unix.Unix_error (Unix.EEXIST, _, _) when attempts > 1 ->
      create_temporary path (attempts - 1)

(* Flushes the directory entry the rename made, so that the new generation
   survives a power loss. *)
let sync_directory directory =
  match Unix.openfile directory [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 with
  | exception Unix.Unix_error (error, _, _) -> Error (describe directory error)
  | fd -> (
      match
        Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> Unix.fsync fd)
      with
      | () -> Ok ()
      | exception Unix.Unix_error (error, _, _) ->
          Error (describe directory error))

let write path generation =
  Random.self_init ();
  match create_temporary path 16 with
  | exception Unix.Unix_error (error, _, _) -> Error (describe path error)
  | temporary, fd -> (
      let commit () =
        Fun.protect
          ~finally:(fun () -> Unix.close fd)
          (fun () ->
            write_all fd (Printf.sprintf "%d\n" generation) 0;
            Unix.fchmod fd 0o600;
            Unix.fsync fd);
        Unix.rename temporary path
      in
      match commit () with
      | () -> sync_directory (Filename.dirname path)
      | exception Unix.Unix_error (error, _, _) ->
          (try Unix.unlink temporary with Unix.Unix_error _ -> ());
          Error (describe path error))

let read_file path =
  match Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 with
  | exception Unix.Unix_error (error, _, _) -> Error error
  | fd -> (
      let buffer = Buffer.create 32 and chunk = Bytes.create 4096 in
      let rec loop () =
        let count = Unix.read fd chunk 0 (Bytes.length chunk) in
        if count > 0 then (
          Buffer.add_subbytes buffer chunk 0 count;
          loop ())
      in
      match Fun.protect ~finally:(fun () -> Unix.close fd) loop with
      | () -> Ok (Buffer.contents buffer)
      | exception Unix.Unix_error (error, _, _) -> Error error)

(* mkdir -p: the parents with the default mode, the last directory at 0700,
   as pathlib's mkdir(mode=0o700, parents=True, exist_ok=True). *)
let rec make_directory ?(mode = 0o777) directory =
  if not (Sys.file_exists directory) then (
    let parent = Filename.dirname directory in
    if parent <> directory then make_directory parent;
    try Unix.mkdir directory mode
    with Unix.Unix_error (Unix.EEXIST, _, _) -> ())

let create path =
  match
    make_directory ~mode:0o700 (Filename.dirname path);
    Unix.openfile path
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
      0o600
  with
  | exception Unix.Unix_error (Unix.EEXIST, _, _) -> `Exists
  | exception Unix.Unix_error (error, _, _) -> `Failed (describe path error)
  | fd -> (
      match
        Fun.protect
          ~finally:(fun () -> Unix.close fd)
          (fun () -> write_all fd "0\n" 0)
      with
      | () -> `Created
      | exception Unix.Unix_error (error, _, _) -> `Failed (describe path error)
      )

let now_in_nanoseconds () =
  Int64.to_int (Int64.of_float (Unix.gettimeofday () *. 1e9))

let repair ~warn path =
  let generation = now_in_nanoseconds () in
  warn
    (Printf.sprintf
       "session-mesh: %s is not a generation number; every login is revoked"
       path);
  Result.map (fun () -> generation) (write path generation)

(* A file created by another process between our read and our create is read
   again; a bound keeps a file that keeps vanishing from looping for ever. *)
let rec read_attempt ~warn path attempts =
  match read_file path with
  | Ok text -> (
      match parse text with Some value -> Ok value | None -> repair ~warn path)
  | Error Unix.ENOENT when attempts > 0 -> (
      match create path with
      | `Created -> Ok 0
      | `Exists -> read_attempt ~warn path (attempts - 1)
      | `Failed message -> Error message)
  | Error error -> Error (describe path error)

let read ~warn path = read_attempt ~warn path 8

let bump ~warn path =
  Result.bind (read ~warn path) (fun current ->
      if current = max_int then
        Error (path ^ ": the generation cannot be raised")
      else
        let next = current + 1 in
        Result.map (fun () -> next) (write path next))
