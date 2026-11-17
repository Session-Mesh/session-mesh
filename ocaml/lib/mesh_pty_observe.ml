(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type event =
  | Create
  | Attach
  | Detach
  | Kill
  | Resize
  | Input of int
  | Output of int
  | Exit

type t = {
  path : string;
  identity : Unix.stats;
  mutable fd : Unix.file_descr option;
  expires_at : Mtime.t;
  mutable expired : bool;
  max_events : int;
  mutable count : int;
  pending : string Queue.t;
}

let valid_basename name =
  let length = String.length name in
  length > 0 && length <= 64 && name <> "." && name <> ".."
  && name <> "ptyhost.sock"
  && String.for_all
       (function
         | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' | '.' | '-' | '_' -> true
         | _ -> false)
       name

let write_all fd data =
  let rec loop offset =
    if offset < String.length data then
      let count =
        Unix.write_substring fd data offset (String.length data - offset)
      in
      if count = 0 then raise End_of_file else loop (offset + count)
  in
  loop 0

let remove_owned path identity =
  match Unix.lstat path with
  | stat
    when stat.Unix.st_kind = Unix.S_REG
         && stat.Unix.st_dev = identity.Unix.st_dev
         && stat.Unix.st_ino = identity.Unix.st_ino ->
      Unix.unlink path
  | _ | (exception Unix.Unix_error (Unix.ENOENT, _, _)) -> ()

let create ~directory ~basename ~now ~lifetime ~max_events =
  if
    (not (valid_basename basename))
    || (not (Float.is_finite lifetime))
    || lifetime <= 0. || lifetime > 600. || max_events <= 0 || max_events > 1024
  then invalid_arg "unsafe passive observation configuration";
  let span =
    match Mtime.Span.of_float_ns (lifetime *. 1e9) with
    | Some span -> span
    | None -> invalid_arg "invalid passive observation lifetime"
  in
  let expires_at =
    match Mtime.add_span now span with
    | Some deadline -> deadline
    | None -> invalid_arg "passive observation deadline overflow"
  in
  let parent = Unix.lstat directory in
  if
    Filename.is_relative directory
    || Unix.realpath directory <> directory
    || parent.Unix.st_kind <> Unix.S_DIR
    || parent.Unix.st_uid <> Unix.geteuid ()
    || parent.Unix.st_perm land 0o077 <> 0
  then invalid_arg "passive observation requires a private directory";
  let path = Filename.concat directory basename in
  let fd =
    Unix.openfile path
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
      0o600
  in
  let identity = Unix.fstat fd in
  try
    if identity.Unix.st_kind <> Unix.S_REG then
      invalid_arg "passive observation requires a regular file";
    Unix.fchmod fd 0o600;
    write_all fd "{\"schema\":\"mesh-pty-observe/v1\"}\n";
    {
      path;
      identity;
      fd = Some fd;
      expires_at;
      expired = false;
      max_events;
      count = 0;
      pending = Queue.create ();
    }
  with ex ->
    Unix.close fd;
    remove_owned path identity;
    raise ex

let expire t =
  match t.fd with
  | None -> ()
  | Some fd -> (
      t.fd <- None;
      Queue.clear t.pending;
      (try Unix.close fd with Unix.Unix_error _ -> ());
      try remove_owned t.path t.identity with Unix.Unix_error _ -> ())

let with_sink ~directory ~basename ~now ~lifetime ~max_events use =
  let sink = create ~directory ~basename ~now ~lifetime ~max_events in
  Fun.protect ~finally:(fun () -> expire sink) (fun () -> use sink)

let family = function
  | Create -> "create"
  | Attach -> "attach"
  | Detach -> "detach"
  | Kill -> "kill"
  | Resize -> "resize"
  | Input _ -> "input"
  | Output _ -> "output"
  | Exit -> "exit"

let byte_class count =
  if count <= 0 then "empty"
  else if count <= 4096 then "small"
  else if count <= 1024 * 1024 then "medium"
  else "large"

let line sequence event =
  let detail =
    match event with
    | Input n | Output n -> ",\"bytes\":\"" ^ byte_class n ^ "\""
    | _ -> ""
  in
  Printf.sprintf "{\"seq\":%d,\"family\":\"%s\"%s}\n" sequence (family event)
    detail

let record t ~now event =
  try
    if Mtime.compare now t.expires_at >= 0 then t.expired <- true
    else if (not t.expired) && Option.is_some t.fd && t.count < t.max_events
    then (
      Queue.add (line t.count event) t.pending;
      t.count <- t.count + 1)
  with _ -> t.expired <- true

let drain t =
  match t.fd with
  | None -> ()
  | Some fd -> (
      try
        while not (Queue.is_empty t.pending) do
          write_all fd (Queue.take t.pending)
        done
      with _ -> expire t)

let tick t ~now =
  if t.expired || Mtime.compare now t.expires_at >= 0 then expire t else drain t

let active t = Option.is_some t.fd
