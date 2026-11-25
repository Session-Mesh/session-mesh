(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* A full-screen program sets the alternate screen and mouse reporting once,
   then writes more than the two MiB a replay keeps. A client attached from
   the start receives the bytes as they come and nothing more; a client
   attaching afterwards receives the modes, then the cut window. The host is
   the executable given as the first argument. *)

open Ptyhost_blackbox

let host_argv = ref [||]
let member key json = Yojson.Basic.Util.member key json
let startup = "\027[?1049h\027[?1000h\027[?1003h\027[?1006h\027[?2004h"
let expected_prefix = "\027[?1049h\027[?2004h\027[?1003h\027[?1006h"

(* [fullscreen]: waits for $HOME/go, sets the modes, writes 3 MB of lines.
   [small]: sets the modes and writes one line. Then both wait. *)
let program = function
  | `Fullscreen ->
      "#!/bin/sh\n\
       while [ ! -f \"$HOME/go\" ]; do sleep 0.05; done\n\
       printf '\\033[?1049h\\033[?1000h\\033[?1003h\\033[?1006h\\033[?2004h'\n\
       head -c 3000000 /dev/zero | tr '\\000' x | fold -w 99\n\
       echo; echo MARK-END\n\
       exec sleep 600\n"
  | `Small ->
      "#!/bin/sh\nprintf '\\033[?1049h\\033[?1003hsmall\\n'\nexec sleep 600\n"

let with_host kind f =
  let scratch =
    Filename.temp_dir
      ~temp_dir:(Test_scratch.short_temp_root ())
      "pty-modes-" ""
  in
  let home = Filename.concat scratch "home" in
  let runtime = Filename.concat scratch "run" in
  let shell = Filename.concat scratch "session-program.sh" in
  let socket_path = Filename.concat runtime "session-mesh/ptyhost.sock" in
  Unix.mkdir home 0o700;
  Unix.mkdir runtime 0o700;
  write_shell shell (program kind);
  let pid = host (start_host !host_argv ~home ~runtime ~shell) in
  let session_pids () =
    match request socket_path {|{"op":"list"}|} with
    | `List sessions ->
        List.map (fun s -> Yojson.Basic.Util.to_int (member "pid" s)) sessions
    | _ -> []
    | exception Unix.Unix_error _ -> []
  in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun session ->
          try Unix.kill (-session) Sys.sigkill
          with Unix.Unix_error (Unix.ESRCH, _, _) -> ())
        (session_pids ());
      stop pid;
      remove_tree scratch)
    (fun () ->
      wait_answering socket_path;
      let created =
        request socket_path
          (Yojson.Basic.to_string
             (`Assoc
                [
                  ("op", `String "new");
                  ("name", `String "modes");
                  ("cwd", `String home);
                ]))
      in
      expect "session created" (member "ok" created = `Bool true);
      f ~home socket_path)

let read_frame socket =
  let head = read_exactly socket 5 in
  let length = Int32.to_int (Bytes.get_int32_be head 1) in
  (Bytes.get head 0, Bytes.to_string (read_exactly socket length))

(* Attach, check the reply, and give [f] the socket and the replay. *)
let attached ?(conditional = false) socket_path f =
  let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close socket)
    (fun () ->
      Unix.setsockopt_float socket Unix.SO_RCVTIMEO 10.;
      Unix.connect socket (Unix.ADDR_UNIX socket_path);
      let payload =
        if not conditional then {|{"op":"attach","name":"modes"}|}
        else
          let sessions = request socket_path {|{"op":"list"}|} in
          let session =
            List.find
              (fun session -> member "name" session = `String "modes")
              (Yojson.Basic.Util.to_list sessions)
          in
          Yojson.Basic.to_string
            (`Assoc
               [
                 ("op", `String "attach_if");
                 ("name", `String "modes");
                 ("created", member "created" session);
                 ("size", `String "claim");
               ])
      in
      let head = Bytes.create 5 in
      Bytes.set head 0 'C';
      Bytes.set_int32_be head 1 (Int32.of_int (String.length payload));
      let message = Bytes.to_string head ^ payload in
      expect "attach written whole"
        (Unix.write_substring socket message 0 (String.length message)
        = String.length message);
      let kind, reply = read_frame socket in
      expect "a control reply first" (kind = 'C');
      expect "attached"
        (member "ok" (Yojson.Basic.from_string reply) = `Bool true);
      if conditional then
        expect "conditional input is acknowledged"
          (List.mem (`String "conditional_input_v1")
             (Yojson.Basic.Util.to_list
                (member "pty_capabilities" (Yojson.Basic.from_string reply))));
      let kind, replay = read_frame socket in
      expect "the replay next" (kind = 'D');
      f socket replay)

(* Live output until [marker], keeping only the last bytes to search in. *)
let read_until socket marker =
  let rec loop tail received =
    let kind, payload = read_frame socket in
    if kind <> 'D' then loop tail received
    else
      let text = tail ^ payload in
      let received = received + String.length payload in
      if contains text marker then received
      else
        let keep = min (String.length text) 64 in
        loop (String.sub text (String.length text - keep) keep) received
  in
  loop "" 0

let starts_with ~prefix text =
  String.length text >= String.length prefix
  && String.sub text 0 (String.length prefix) = prefix

let check_late_replay label replay =
  if not (starts_with ~prefix:expected_prefix replay) then
    Alcotest.failf "%s: the replay starts with %S" label
      (String.sub replay 0 (min 80 (String.length replay)));
  let window =
    String.sub replay
      (String.length expected_prefix)
      (String.length replay - String.length expected_prefix)
  in
  Alcotest.(check bool)
    (label ^ ": a cut window") false
    (contains window "\027[?1049h");
  Alcotest.(check bool)
    (label ^ ": within the capacity")
    true
    (String.length window <= 2 * 1024 * 1024);
  Alcotest.(check bool)
    (label ^ ": up to the end")
    true
    (contains window "MARK-END")

let late_clients_get_the_modes conditional () =
  with_host `Fullscreen (fun ~home socket_path ->
      attached socket_path (fun live replay ->
          Alcotest.(check string) "attached from the start: no prefix" "" replay;
          write_shell (Filename.concat home "go") "";
          let received = read_until live "MARK-END" in
          Alcotest.(check bool)
            "more than the capacity went by" true
            (received > 2 * 1024 * 1024);
          attached ~conditional socket_path (fun _ replay ->
              check_late_replay "a late client" replay);
          attached ~conditional socket_path (fun _ replay ->
              check_late_replay "a later client" replay)))

let uncut_replay_is_unchanged conditional () =
  with_host `Small (fun ~home:_ socket_path ->
      let replay = ref "" in
      ignore
        (wait_until "the program wrote" 10. (fun () ->
              attached ~conditional socket_path (fun _ bytes ->
                 replay := bytes;
                 contains bytes "small\r\n")));
      Alcotest.(check string)
        "exactly the output" "\027[?1049h\027[?1003hsmall\r\n" !replay)

let () =
  let argv = Sys.argv in
  if Array.length argv < 2 then
    invalid_arg
      "usage: ptyhost_replay_modes_test 'HOST [ARGS]' [alcotest options]";
  host_argv :=
    Array.of_list (List.filter (( <> ) "") (String.split_on_char ' ' argv.(1)));
  Alcotest.run
    ~argv:
      (Array.append [| argv.(0) |] (Array.sub argv 2 (Array.length argv - 2)))
    "PTY host replay modes"
    [
      ( "attach",
        [
          Alcotest.test_case "late clients receive the modes first" `Quick
            (late_clients_get_the_modes false);
          Alcotest.test_case "an uncut replay is unchanged" `Quick
            (uncut_replay_is_unchanged false);
          Alcotest.test_case "conditional clients receive the modes first" `Quick
            (late_clients_get_the_modes true);
          Alcotest.test_case "an uncut conditional replay is unchanged" `Quick
            (uncut_replay_is_unchanged true);
        ] );
    ]
