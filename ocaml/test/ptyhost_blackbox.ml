(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Drive a PTY host executable from outside, over its Unix socket only. *)

let expect label value = if not value then failwith label

let rec remove_tree path =
  match (Unix.lstat path).Unix.st_kind with
  | Unix.S_DIR ->
      Array.iter
        (fun entry -> remove_tree (Filename.concat path entry))
        (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let read_exactly socket length =
  let buffer = Bytes.create length in
  let rec fill offset =
    if offset < length then
      match Unix.read socket buffer offset (length - offset) with
      | 0 -> failwith "the host closed the connection"
      | count -> fill (offset + count)
  in
  fill 0;
  buffer

(* One control request, given as raw JSON text, and its parsed reply. *)
let request socket_path payload =
  let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close socket)
    (fun () ->
      Unix.setsockopt_float socket Unix.SO_RCVTIMEO 5.;
      Unix.connect socket (Unix.ADDR_UNIX socket_path);
      let head = Bytes.create 5 in
      Bytes.set head 0 'C';
      Bytes.set_int32_be head 1 (Int32.of_int (String.length payload));
      let message = Bytes.to_string head ^ payload in
      expect "request written whole"
        (Unix.write_substring socket message 0 (String.length message)
        = String.length message);
      let length = Bytes.get_int32_be (read_exactly socket 5) 1 in
      Yojson.Basic.from_string
        (Bytes.to_string (read_exactly socket (Int32.to_int length))))

let wait_until label timeout condition =
  let start = Unix.gettimeofday () in
  while not (condition ()) do
    if Unix.gettimeofday () -. start > timeout then
      failwith (Printf.sprintf "%s: not within %.0f s" label timeout);
    Unix.sleepf 0.02
  done;
  Unix.gettimeofday () -. start

let alive pid =
  match Unix.kill pid 0 with
  | () -> true
  | exception Unix.Unix_error (Unix.ESRCH, _, _) -> false

(* The socket file can exist before the host listens on it. *)
let answering socket_path =
  match request socket_path {|{"op":"list"}|} with
  | _ -> true
  | exception
      Unix.Unix_error ((Unix.ENOENT | Unix.ECONNREFUSED | Unix.EAGAIN), _, _) ->
      false

let wait_answering socket_path =
  ignore (wait_until "host answering" 10. (fun () -> answering socket_path))

let write_shell path script =
  let channel = open_out_gen [ Open_wronly; Open_creat ] 0o700 path in
  output_string channel script;
  close_out channel

(* The environment is built here, never inherited: a caller's
   [MESH_RUNTIME_DIR] would otherwise take precedence over [runtime].
   [environment] adds entries, for instance [MESH_RUNTIME_DIR] itself. *)
let start_host ?(stderr = Unix.stderr) ?(environment = []) argv ~home ~runtime
    ~shell =
  let environment =
    Array.append
      [|
        "PATH=/usr/bin:/bin";
        "LANG=C";
        "HOME=" ^ home;
        "XDG_RUNTIME_DIR=" ^ runtime;
        "SHELL=" ^ shell;
      |]
      (Array.of_list environment)
  in
  let null = Unix.openfile "/dev/null" [ Unix.O_RDWR ] 0 in
  let pid =
    Unix.create_process_env argv.(0) argv environment null null stderr
  in
  Unix.close null;
  pid

let stop_host pid =
  (try Unix.kill pid Sys.sigterm with Unix.Unix_error (Unix.ESRCH, _, _) -> ());
  ignore (Unix.waitpid [] pid)

(* A host process that a test may see exit before stopping it. *)
type host = { pid : int; mutable status : Unix.process_status option }

let host pid = { pid; status = None }

let exited host =
  (if host.status = None then
     match Unix.waitpid [ Unix.WNOHANG ] host.pid with
     | 0, _ -> ()
     | _, status -> host.status <- Some status);
  host.status

let stop host = if exited host = None then stop_host host.pid

let file_contents path =
  let channel = open_in_bin path in
  Fun.protect
    ~finally:(fun () -> close_in_noerr channel)
    (fun () -> really_input_string channel (in_channel_length channel))

let contains haystack needle =
  let rec loop offset =
    offset + String.length needle <= String.length haystack
    && (String.sub haystack offset (String.length needle) = needle
       || loop (offset + 1))
  in
  loop 0
