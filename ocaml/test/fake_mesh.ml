(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* A fake one-shot mesh and a run of mesh-logout-all against it. *)

let token = "the-master-token"

let rec remove path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Array.iter
        (fun name -> remove (Filename.concat path name))
        (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let contents path = In_channel.with_open_bin path In_channel.input_all

let write_file path text =
  Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_trunc ] 0o600 path
    (fun channel -> output_string channel text)

(* A configuration directory with the token and generation 5. *)
let with_conf f =
  let conf = Test_scratch.private_directory "mesh-logout-all-" in
  Fun.protect
    ~finally:(fun () -> remove conf)
    (fun () ->
      write_file (Filename.concat conf "token") (token ^ "\n");
      write_file (Filename.concat conf "cookie-generation") "5\n";
      f conf)

let generation_file conf = Filename.concat conf "cookie-generation"

type behaviour =
  | Answer of string
  | Answer_then_stall of string
  | Answer_then_reset of string
  | Flood of string * string
      (** A prefix, then the second text again and again until killed. *)
  | Stall
  | Close
  | Reset

let rec waitpid_retrying child =
  try ignore (Unix.waitpid [] child)
  with Unix.Unix_error (Unix.EINTR, _, _) -> waitpid_retrying child

let rec read_request client buffer =
  let chunk = Bytes.create 4096 in
  let count = try Unix.read client chunk 0 4096 with Unix.Unix_error _ -> 0 in
  Buffer.add_subbytes buffer chunk 0 count;
  let text = Buffer.contents buffer in
  let complete =
    let marker = "\r\n\r\n" in
    let rec find i =
      i + 4 <= String.length text
      && (String.sub text i 4 = marker || find (i + 1))
    in
    find 0
  in
  if count > 0 && not complete then read_request client buffer

(* The child accepts one connection, hands the request to the parent through
   [report], then behaves. It never runs the parent's at_exit handlers. *)
let serve socket report behaviour =
  ignore (Unix.alarm 10);
  let client, _ = Unix.accept socket in
  let request = Buffer.create 256 in
  read_request client request;
  let text = Buffer.contents request in
  ignore (Unix.write_substring report text 0 (String.length text));
  Unix.close report;
  let send text =
    ignore (Unix.write_substring client text 0 (String.length text))
  in
  (* Closing with no linger time sends a reset instead of an orderly end. *)
  let reset () = Unix.setsockopt_optint client Unix.SO_LINGER (Some 0) in
  (match behaviour with
  | Answer response -> send response
  | Answer_then_stall response ->
      send response;
      Unix.sleep 9
  | Answer_then_reset response ->
      send response;
      Unix.sleepf 0.3;
      reset ()
  | Flood (prefix, again) ->
      send prefix;
      while true do
        send again
      done
  | Stall -> Unix.sleep 9
  | Close -> ()
  | Reset -> reset ());
  Unix.close client;
  Unix._exit 0

let listening () =
  let socket = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.setsockopt socket Unix.SO_REUSEADDR true;
  Unix.bind socket (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
  Unix.listen socket 1;
  match Unix.getsockname socket with
  | Unix.ADDR_INET (_, port) -> (socket, port)
  | Unix.ADDR_UNIX _ -> failwith "expected an internet socket"

(* [f port] runs against the fake mesh; the result comes with the request the
   mesh received ("" when none reached it). *)
let with_mesh behaviour f =
  let socket, port = listening () in
  let report_out, report_in = Unix.pipe ~cloexec:true () in
  match Unix.fork () with
  | 0 -> (
      (* The child must never unwind into the caller's frames: an exception
         would run their finalisers in the child, such as [with_conf] removing
         the configuration directory the parent still reads. A write to a peer
         that has gone (EPIPE, SIGPIPE being ignored, or ECONNRESET) and any
         other exception end the child here. *)
      try
        Sys.set_signal Sys.sigpipe Sys.Signal_ignore;
        Unix.close report_out;
        serve socket report_in behaviour
      with _ -> Unix._exit 0)
  | child ->
      Unix.close report_in;
      Unix.close socket;
      (* The report's read end is closed however [f] or the read ends. *)
      let channel = Unix.in_channel_of_descr report_out in
      Fun.protect
        ~finally:(fun () -> close_in_noerr channel)
        (fun () ->
          let result =
            Fun.protect
              ~finally:(fun () ->
                (try Unix.kill child Sys.sigkill with Unix.Unix_error _ -> ());
                waitpid_retrying child)
              (fun () -> f port)
          in
          (result, In_channel.input_all channel))

let closed_port () =
  let socket, port = listening () in
  Unix.close socket;
  port

type run = { code : int; out : string list; err : string list }

let run ?(timeout = 10.) ?(args = []) ?(extra = []) conf port =
  let out = ref [] and err = ref [] in
  let environment =
    extra
    @ [
        ("HOME", conf);
        ("MESH_CONF_DIR", conf);
        ("MESH_PORT", string_of_int port);
      ]
  in
  let code =
    Mesh_logout_all.run ~timeout
      ~getenv:(fun name -> List.assoc_opt name environment)
      ~args
      {
        out = (fun line -> out := line :: !out);
        err = (fun line -> err := line :: !err);
      }
  in
  { code; out = List.rev !out; err = List.rev !err }

let contains text fragment =
  let n = String.length fragment in
  let rec scan i =
    i + n <= String.length text
    && (String.sub text i n = fragment || scan (i + 1))
  in
  scan 0

let check_no_token result =
  List.iter
    (fun line ->
      Alcotest.(check bool)
        ("token absent from: " ^ line)
        false (contains line token))
    (result.out @ result.err)

let http status ?(headers = "") body =
  Printf.sprintf
    "HTTP/1.1 %s\r\n\
     %sContent-Type: application/json\r\n\
     Content-Length: %d\r\n\
     Connection: close\r\n\
     \r\n\
     %s"
    status headers (String.length body) body
