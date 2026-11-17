(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* [kill] ends a session with SIGHUP, and an ignored signal stays ignored
   across exec. The host given as first argument is started with SIGHUP
   ignored, as under nohup, and the session's program keeps whatever
   disposition it inherits: [kill] must still end it.

   A program can also lose one SIGHUP: bash that receives it while starting
   records it, then waits for input without acting on it. The host repeats
   the signal while the program has not exited; the second case runs a
   program that loses the first SIGHUP every time. *)

let gone_timeout = 5.
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

let keeps_dispositions = "#!/bin/sh\n: > \"$HOME/ready\"\nexec sleep 600\n"

let loses_first_sighup =
  "#!/bin/sh\n\
   trap 'if [ -e \"$HOME/first-lost\" ]; then exit 0; fi; : > \
   \"$HOME/first-lost\"' HUP\n\
   : > \"$HOME/ready\"\n\
   while :; do sleep 0.05; done\n"

let write_shell path script =
  let channel = open_out_gen [ Open_wronly; Open_creat ] 0o700 path in
  output_string channel script;
  close_out channel

let start_host host ~home ~runtime ~shell =
  let environment =
    [|
      "PATH=/usr/bin:/bin";
      "LANG=C";
      "HOME=" ^ home;
      "XDG_RUNTIME_DIR=" ^ runtime;
      "SHELL=" ^ shell;
    |]
  in
  let null = Unix.openfile "/dev/null" [ Unix.O_RDWR ] 0 in
  Sys.set_signal Sys.sighup Sys.Signal_ignore;
  let pid =
    Unix.create_process_env host [| host |] environment null null Unix.stderr
  in
  Unix.close null;
  pid

(* The pid of the new session's program. *)
let create_session socket_path home =
  let fields =
    [ ("op", `String "new"); ("name", `String "hup"); ("cwd", `String home) ]
  in
  let created = request socket_path (Yojson.Basic.to_string (`Assoc fields)) in
  expect "session created" (Yojson.Basic.Util.member "ok" created = `Bool true);
  match request socket_path {|{"op":"list"}|} with
  | `List [ session ] -> Yojson.Basic.Util.(to_int (member "pid" session))
  | _ -> failwith "one session listed"

let check host scratch session_pid ~script ~lost_first =
  let home = Filename.concat scratch "home"
  and runtime = Filename.concat scratch "run"
  and shell = Filename.concat scratch "session-program.sh" in
  Unix.mkdir home 0o700;
  Unix.mkdir runtime 0o700;
  write_shell shell script;
  let socket_path = Filename.concat runtime "session-mesh/ptyhost.sock" in
  let host_pid = start_host host ~home ~runtime ~shell in
  Fun.protect
    ~finally:(fun () ->
      Unix.kill host_pid Sys.sigterm;
      ignore (Unix.waitpid [] host_pid))
    (fun () ->
      let sessions () = request socket_path {|{"op":"list"}|} in
      (* The socket file can exist before the host listens on it. *)
      ignore
        (wait_until "host answering" 10. (fun () ->
             match sessions () with
             | _ -> true
             | exception
                 Unix.Unix_error ((Unix.ENOENT | Unix.ECONNREFUSED), _, _) ->
                 false));
      session_pid := create_session socket_path home;
      ignore
        (wait_until "session program started" 10. (fun () ->
             Sys.file_exists (Filename.concat home "ready")));
      expect "kill accepted"
        (request socket_path {|{"op":"kill","name":"hup"}|}
        = `Assoc [ ("ok", `Bool true) ]);
      let elapsed =
        wait_until "session gone from the listing" gone_timeout (fun () ->
            sessions () = `List [])
      in
      expect "session program reaped" (not (alive !session_pid));
      expect "the program lost a first SIGHUP"
        (Sys.file_exists (Filename.concat home "first-lost") = lost_first);
      Printf.printf
        "kill ended the session %.0f ms after the request, host started with \
         SIGHUP ignored%s\n"
        (elapsed *. 1000.)
        (if lost_first then ", first SIGHUP lost by the program" else ""))

let () =
  let host =
    match Sys.argv with
    | [| _; host |] -> host
    | _ -> invalid_arg "usage: ptyhost_inherited_sighup_test HOST"
  in
  List.iter
    (fun (script, lost_first) ->
      (* Canonical: the host refuses a runtime directory reached through a
         symbolic link, as the temporary directory is on macOS. *)
      let scratch =
        Filename.temp_dir
          ~temp_dir:(Test_scratch.short_temp_root ())
          "pty-hup-" ""
      in
      let session_pid = ref 0 in
      Fun.protect
        ~finally:(fun () ->
          (if !session_pid > 0 then
             try Unix.kill (- !session_pid) Sys.sigkill
             with Unix.Unix_error (Unix.ESRCH, _, _) -> ());
          remove_tree scratch)
        (fun () -> check host scratch session_pid ~script ~lost_first))
    [ (keeps_dispositions, false); (loses_first_sighup, true) ]
