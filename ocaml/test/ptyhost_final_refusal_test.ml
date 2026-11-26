(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(******************************************************************************)

open Ptyhost_blackbox
let member = Yojson.Basic.Util.member

let send_frame socket kind text =
  let head = Bytes.create 5 in
  Bytes.set head 0 kind;
  Bytes.set_int32_be head 1 (Int32.of_int (String.length text));
  let data = Bytes.to_string head ^ text in
  let rec write offset =
    if offset < String.length data then
      write (offset + Unix.write_substring socket data offset (String.length data - offset))
  in write 0

let attach path created =
  let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Unix.setsockopt_float socket Unix.SO_RCVTIMEO 5.;
  Unix.connect socket (Unix.ADDR_UNIX path);
  let fields = ["op", `String (if Option.is_some created then "attach_if" else "attach");
                "name", `String "relaunch"; "rows", `Int 24; "cols", `Int 80] in
  let fields = match created with None -> fields | Some value ->
    ("created", value) :: ("size", `String "claim") :: fields in
  send_frame socket 'C' (Yojson.Basic.to_string (`Assoc fields));
  let header = read_exactly socket 5 in
  expect "attach control reply" (Bytes.get header 0 = 'C');
  let payload = read_exactly socket (Int32.to_int (Bytes.get_int32_be header 1)) in
  expect "attach admitted" (member "ok" (Yojson.Basic.from_string (Bytes.to_string payload)) = `Bool true);
  socket

let post_signal_refusal_retires_old_stream () =
  let scratch = Test_scratch.private_directory "pty-final-refusal-" in
  let home = Filename.concat scratch "home" and runtime = Filename.concat scratch "run" in
  List.iter (fun path -> Unix.mkdir path 0o700) [home; runtime];
  let shell = Filename.concat scratch "shell.sh" and agent = Filename.concat scratch "claude" in
  write_shell shell "#!/bin/sh\nexec /bin/sh -i\n";
  write_shell agent (file_contents (Unix.realpath "/bin/bash"));
  let script = Filename.concat scratch "agent.sh" in
  write_shell script "#!/bin/sh\ntrap 'echo hup > \"$HOME/hup\"; exit 0' HUP\necho ready > \"$HOME/ready\"\nwhile :; do sleep 0.05; done\n";
  let argv = [|Unix.realpath Sys.executable_name; "--host"|] in
  let host = host (start_host argv ~home ~runtime ~shell) in
  Fun.protect ~finally:(fun () -> stop host; remove_tree scratch) (fun () ->
    let path = Filename.concat runtime "session-mesh/ptyhost.sock" in
    wait_answering path;
    let request fields = request path (Yojson.Basic.to_string (`Assoc fields)) in
    let created = request ["op", `String "new"; "name", `String "relaunch";
      "cwd", `String home; "command", `String (agent ^ " " ^ script);
      "meta", `Assoc ["nonce", `String "n1"; "agent", `String "claude"]] in
    expect "created" (member "ok" created = `Bool true);
    ignore (wait_until "agent ready" 10. (fun () -> Sys.file_exists (Filename.concat home "ready")));
    let session = match request ["op", `String "list"] with `List [s] -> s | _ -> failwith "session listing" in
    let birth = member "created" session in
    let old = attach path (Some birth) in
    Fun.protect ~finally:(fun () -> Unix.close old) (fun () ->
      let result = request ["op", `String "stop_agent_if"; "name", `String "relaunch";
        "created", birth; "agent", `String "claude"] in
      expect "agent received HUP" (Sys.file_exists (Filename.concat home "hup"));
      expect "post-signal refusal is uncertain" (member "reason" result = `String "agent_stop_uncertain");
      let marker = Filename.concat home "old-stream-ran" in
      (try send_frame old 'D' ("touch " ^ Filename.quote marker ^ "\r") with Unix.Unix_error _ -> ());
      (* The server must have processed the old stream before the shell
         barrier. Drain its output until the host closes it. *)
      let buffer = Bytes.create 4096 in
      let rec await_close () =
        match Unix.read old buffer 0 (Bytes.length buffer) with
        | 0 -> ()
        | _ -> await_close ()
      in
      await_close ();
      let fresh = attach path None in
      Fun.protect ~finally:(fun () -> Unix.close fresh) (fun () ->
        let barrier = Filename.concat home "barrier" in
        send_frame fresh 'D' ("touch " ^ Filename.quote barrier ^ "\r");
        ignore (wait_until "shell barrier" 5. (fun () -> Sys.file_exists barrier));
        expect "old stream never reached shell" (not (Sys.file_exists marker)))))

let () =
  if Array.length Sys.argv = 2 && Sys.argv.(1) = "--host" then
    Ptyhost_final_refusal_impl.run ()
  else Alcotest.run "ptyhost_final_refusal"
    ["stop", [Alcotest.test_case "post-signal refusal retires old stream" `Slow post_signal_refusal_retires_old_stream]]
