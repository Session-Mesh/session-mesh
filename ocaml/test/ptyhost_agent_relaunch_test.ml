(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* [stop_agent_if] then [start_if]: the agent a session's shell runs is
   stopped and started again in the same terminal, under another account
   folder, as an account switch does. The host is the executable given as the
   first argument; the session program is an interactive /bin/sh, and the
   agent a script named claude that logs its starts and stops. *)

open Ptyhost_blackbox

let host_argv = ref [||]
let member = Yojson.Basic.Util.member

type fixture = { home : string; socket_path : string; agent : string }

(* [graceful]: ends 0.3 s after SIGHUP; [stubborn]: ignores it. A start
   while the previous agent still runs is logged as an overlap. *)
let agent_script =
  "#!/bin/sh\n\
   log=\"$HOME/agent.log\"\n\
   if [ -f \"$HOME/agent.pid\" ] && kill -0 \"$(cat \"$HOME/agent.pid\")\" \
   2>/dev/null; then echo overlap >> \"$log\"; fi\n\
   echo $$ > \"$HOME/agent.pid\"\n\
   echo \"start $$ ${CLAUDE_CONFIG_DIR-unset}\" >> \"$log\"\n\
   echo \"agent-start $$ ${CLAUDE_CONFIG_DIR-unset}\"\n\
   case \"$1\" in\n\
   stubborn) trap 'echo \"hup $$\" >> \"$log\"' HUP ;;\n\
   *) trap 'sleep 0.3; echo \"stop $$\" >> \"$log\"; exit 0' HUP ;;\n\
   esac\n\
   while :; do sleep 0.1; done\n"

let log_lines fixture =
  let path = Filename.concat fixture.home "agent.log" in
  if Sys.file_exists path then
    List.filter (( <> ) "") (String.split_on_char '\n' (file_contents path))
  else []

let agent_pids fixture =
  List.filter_map
    (fun line ->
      match String.split_on_char ' ' line with
      | [ "start"; pid; _ ] -> int_of_string_opt pid
      | _ -> None)
    (log_lines fixture)

let with_host ?(grace = "0.5") f =
  let scratch = Test_scratch.private_directory "pty-relaunch-" in
  let fixture =
    {
      home = Filename.concat scratch "home";
      socket_path = Filename.concat scratch "run/session-mesh/ptyhost.sock";
      agent =
        Filename.concat scratch "bin/claude"
        ^ " "
        ^ Filename.concat scratch "bin/agent.sh";
    }
  in
  List.iter
    (fun dir -> Unix.mkdir (Filename.concat scratch dir) 0o700)
    [ "home"; "run"; "bin" ];
  write_shell (Filename.concat scratch "bin/agent.sh") agent_script;
  (* A copy of bash named claude runs the script: its process is named claude
     on Linux and macOS alike (a script's own name is not, on macOS). *)
  write_shell
    (Filename.concat scratch "bin/claude")
    (file_contents (Unix.realpath "/bin/bash"));
  let shell = Filename.concat scratch "shell.sh" in
  write_shell shell "#!/bin/sh\nexec /bin/sh -i\n";
  let pid =
    host
      (start_host
         ~environment:[ "MESH_PTYHOST_AGENT_STOP_GRACE=" ^ grace ]
         !host_argv ~home:fixture.home
         ~runtime:(Filename.concat scratch "run")
         ~shell)
  in
  Fun.protect
    ~finally:(fun () ->
      let agents = agent_pids fixture in
      List.iter
        (fun pid ->
          try Unix.kill (-pid) Sys.sigkill with Unix.Unix_error _ -> ())
        agents;
      stop pid;
      remove_tree scratch)
    (fun () ->
      wait_answering fixture.socket_path;
      f fixture)

let send fixture fields =
  request fixture.socket_path (Yojson.Basic.to_string (`Assoc fields))

let the_session fixture =
  match request fixture.socket_path {|{"op":"list"}|} with
  | `List [ session ] -> session
  | other -> failwith ("one session: " ^ Yojson.Basic.to_string other)

let started fixture count =
  ignore
    (wait_until "agent started" 15. (fun () ->
         List.length (agent_pids fixture) >= count))

let new_agent ?(mode = "graceful") ?(background = false) ?(prefix = "") fixture
    =
  let command =
    Printf.sprintf "%sCLAUDE_CONFIG_DIR=/accounts/a %s %s%s" prefix
      fixture.agent mode
      (if background then " &" else "")
  in
  let reply =
    send fixture
      [
        ("op", `String "new");
        ("name", `String "relaunch");
        ("cwd", `String fixture.home);
        ("command", `String command);
        ("meta", `Assoc [ ("nonce", `String "n1"); ("agent", `String "claude") ]);
      ]
  in
  expect "created" (member "ok" reply = `Bool true);
  started fixture 1;
  the_session fixture

let stop_agent fixture created =
  send fixture
    [
      ("op", `String "stop_agent_if");
      ("name", `String "relaunch");
      ("created", created);
      ("agent", `String "claude");
    ]

let start_again ?(meta = [ ("nonce", `String "n1"); ("account", `String "b") ])
    fixture created =
  send fixture
    [
      ("op", `String "start_if");
      ("name", `String "relaunch");
      ("created", created);
      ("command", `String ("env CLAUDE_CONFIG_DIR=/accounts/b " ^ fixture.agent));
      ("meta", `Assoc meta);
    ]

(* An attachment, and everything it has received so far. *)
let attach fixture =
  let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Unix.connect socket (Unix.ADDR_UNIX fixture.socket_path);
  let payload = {|{"op":"attach","name":"relaunch","rows":24,"cols":80}|} in
  let head = Bytes.create 5 in
  Bytes.set head 0 'C';
  Bytes.set_int32_be head 1 (Int32.of_int (String.length payload));
  ignore
    (Unix.write_substring socket
       (Bytes.to_string head ^ payload)
       0
       (5 + String.length payload));
  socket

(* What a person types in an attachment (one D frame). *)
let type_in socket text =
  let head = Bytes.create 5 in
  Bytes.set head 0 'D';
  Bytes.set_int32_be head 1 (Int32.of_int (String.length text));
  let frame = Bytes.to_string head ^ text in
  ignore (Unix.write_substring socket frame 0 (String.length frame))

let received socket =
  let buffer = Buffer.create 4096 and chunk = Bytes.create 4096 in
  Unix.set_nonblock socket;
  let rec drain () =
    match Unix.read socket chunk 0 4096 with
    | 0 -> ()
    | count ->
        Buffer.add_subbytes buffer chunk 0 count;
        drain ()
    | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) -> ()
  in
  drain ();
  Unix.clear_nonblock socket;
  Buffer.contents buffer

let same_terminal () =
  with_host (fun fixture ->
      let before = new_agent fixture in
      let created = member "created" before in
      let old_agent = List.hd (agent_pids fixture) in
      let desk = attach fixture and phone = attach fixture in
      let stopped = stop_agent fixture created in
      expect
        ("stopped: " ^ Yojson.Basic.to_string stopped)
        (member "ok" stopped = `Bool true);
      expect "the old agent is gone when the reply comes"
        (not (alive old_agent));
      let fresh = member "created" stopped in
      expect "a new incarnation" (fresh <> created && fresh <> `Null);
      let after = the_session fixture in
      expect "same shell" (member "pid" after = member "pid" before);
      expect "the listing names the new incarnation"
        (member "created" after = fresh);
      expect "the old incarnation can start nothing"
        (member "ok" (start_again fixture created) = `Bool false);
      let started_again = start_again fixture fresh in
      expect
        ("started: " ^ Yojson.Basic.to_string started_again)
        (member "ok" started_again = `Bool true);
      started fixture 2;
      let lines = log_lines fixture in
      expect "never two agents at once" (not (List.mem "overlap" lines));
      let fresh_agent = List.nth (agent_pids fixture) 1 in
      expect "the new agent runs under the other folder"
        (List.mem (Printf.sprintf "start %d /accounts/b" fresh_agent) lines);
      expect "the old one ended on SIGHUP"
        (List.mem (Printf.sprintf "stop %d" old_agent) lines);
      let marker = Printf.sprintf "agent-start %d /accounts/b" fresh_agent in
      let seen_desk = ref "" and seen_phone = ref "" in
      ignore
        (wait_until "both attachments see the new agent" 5. (fun () ->
             seen_desk := !seen_desk ^ received desk;
             seen_phone := !seen_phone ^ received phone;
             (contains !seen_desk marker && contains !seen_phone marker)
             ||
             (Unix.sleepf 0.1;
              false)));
      let listed = the_session fixture in
      expect "same shell still" (member "pid" listed = member "pid" before);
      expect "both attachments kept" (member "attached" listed = `Int 2);
      expect "the account is the new meta's"
        (member "account" (member "meta" listed) = `String "b");
      Unix.close desk;
      Unix.close phone)

let stubborn_agent_is_killed () =
  with_host (fun fixture ->
      let session = new_agent ~mode:"stubborn" fixture in
      let old_agent = List.hd (agent_pids fixture) in
      let began = Unix.gettimeofday () in
      let stopped = stop_agent fixture (member "created" session) in
      let took = Unix.gettimeofday () -. began in
      expect
        ("stopped: " ^ Yojson.Basic.to_string stopped)
        (member "ok" stopped = `Bool true);
      expect "SIGKILL after the grace" (took >= 0.5);
      expect "gone" (not (alive old_agent));
      expect "it never ended by itself"
        (not
           (List.mem (Printf.sprintf "stop %d" old_agent) (log_lines fixture))))

let refusals_signal_nothing () =
  with_host (fun fixture ->
      let session = new_agent ~background:true fixture in
      let created = member "created" session in
      let agent = List.hd (agent_pids fixture) in
      let refused = stop_agent fixture created in
      expect
        ("a background agent: " ^ Yojson.Basic.to_string refused)
        (member "reason" refused = `String "agent_not_foreground");
      expect "still running" (alive agent);
      expect "same incarnation"
        (member "created" (the_session fixture) = created);
      expect "a stale incarnation is refused"
        (member "ok" (stop_agent fixture (`Float 1.)) = `Bool false);
      expect "no meta on an incarnation whose agent was not stopped"
        (member "ok" (start_again fixture created) = `Bool false))

let bound_agent_refusal_signals_nothing () =
  with_host (fun fixture ->
      let session = new_agent fixture in
      let created = member "created" session in
      let agent = List.hd (agent_pids fixture) in
      let reply =
        send fixture
          [
            ("op", `String "stop_agent_if");
            ("name", `String "relaunch");
            ("created", created);
            ("agent", `String "claude");
            ("agent_pid", `Int agent);
            ("agent_incarnation", `String "1");
            ("agent_input_at", member "last_input" session);
          ]
      in
      expect "mismatched process incarnation refused"
        (member "reason" reply = `String "agent_changed");
      let stale_input = send fixture
        [ ("op", `String "stop_agent_if"); ("name", `String "relaunch");
          ("created", created); ("agent", `String "claude");
          ("agent_pid", `Int agent); ("agent_incarnation", `String "1");
          ("agent_input_at", `Float (-1.)) ] in
      expect "changed input refuses the stop" (member "reason" stale_input = `String "stale_incarnation");
      expect "the agent still runs" (alive agent);
      expect "session incarnation unchanged"
        (member "created" (the_session fixture) = created))

(* A shell without job control runs the agent in its own group: only a stop
   of the whole session could reach it, so nothing is signalled. *)
let no_job_control_signals_nothing () =
  with_host (fun fixture ->
      let session = new_agent ~prefix:"set +m; " fixture in
      let created = member "created" session in
      let agent = List.hd (agent_pids fixture) in
      let refused = stop_agent fixture created in
      expect
        ("the agent in the shell's group: " ^ Yojson.Basic.to_string refused)
        (member "reason" refused = `String "no_job_control");
      expect "still running" (alive agent);
      expect "same incarnation"
        (member "created" (the_session fixture) = created))

(* During the stop a person typed half a line at the prompt: the launch
   erases it first instead of appending the command to it. *)
let half_typed_line_is_erased () =
  with_host (fun fixture ->
      let session = new_agent fixture in
      let desk = attach fixture in
      let stopped = stop_agent fixture (member "created" session) in
      expect "stopped" (member "ok" stopped = `Bool true);
      type_in desk "echo HALF-TYPED";
      Unix.sleepf 0.3;
      expect "started"
        (member "ok" (start_again fixture (member "created" stopped))
        = `Bool true);
      started fixture 2;
      expect "the new agent runs under the new folder"
        (List.exists
           (fun line -> contains line "/accounts/b")
           (log_lines fixture));
      Unix.close desk)

let input_during_stop_does_not_reach_shell () =
  with_host (fun fixture ->
      let session = new_agent ~mode:"stubborn" fixture in
      let desk = attach fixture in
      let marker = Filename.concat fixture.home "unexpected-command" in
      let child = Unix.fork () in
      if child = 0 then (
        let result = stop_agent fixture (member "created" session) in
        exit (if member "ok" result = `Bool true then 0 else 1));
      ignore (wait_until "stubborn agent received HUP" 5. (fun () ->
          List.exists (fun line -> String.starts_with ~prefix:"hup " line) (log_lines fixture)));
      type_in desk ("touch " ^ Filename.quote marker ^ "\r");
      type_in desk ("touch " ^ Filename.quote marker ^ "\r");
      let _, status = Unix.waitpid [] child in
      expect "stop completed" (status = Unix.WEXITED 0);
      let barrier = Filename.concat fixture.home "shell-barrier" in
      type_in desk ("touch " ^ Filename.quote barrier ^ "\r");
      ignore (wait_until "shell processed the barrier" 5. (fun () -> Sys.file_exists barrier));
      expect "held input did not reach the shell" (not (Sys.file_exists marker));
      Unix.close desk)

let meta_keeps_the_nonce () =
  with_host (fun fixture ->
      let session = new_agent fixture in
      let stopped = stop_agent fixture (member "created" session) in
      let fresh = member "created" stopped in
      (match start_again ~meta:[ ("nonce", `String "n2") ] fixture fresh with
      | `Assoc fields when List.mem_assoc "error" fields -> ()
      | other -> failwith ("another nonce: " ^ Yojson.Basic.to_string other));
      expect "the same nonce is accepted"
        (member "ok" (start_again fixture fresh) = `Bool true))

(* A stop that comes while the launch command still waits for the prompt:
   the stopped incarnation's command is dropped, and only the new one is
   typed. *)
let pending_launch_is_dropped () =
  with_host (fun fixture ->
      let reply =
        send fixture
          [
            ("op", `String "new");
            ("name", `String "relaunch");
            ("cwd", `String fixture.home);
            ("command", `String (fixture.agent ^ " graceful"));
            ("meta", `Assoc [ ("nonce", `String "n1") ]);
          ]
      in
      expect "created" (member "ok" reply = `Bool true);
      let stopped =
        stop_agent fixture (member "created" (the_session fixture))
      in
      expect
        ("stopped before the launch: " ^ Yojson.Basic.to_string stopped)
        (member "ok" stopped = `Bool true);
      (* A launch types its command at the latest 10 s after it was requested
         (type_when_ready); past that, a dropped one never runs. *)
      let deadline = Unix.gettimeofday () +. 11. in
      while Unix.gettimeofday () < deadline && agent_pids fixture = [] do
        Unix.sleepf 0.2
      done;
      expect "the stopped launch never ran" (agent_pids fixture = []);
      expect "the new incarnation starts its command"
        (member "ok" (start_again fixture (member "created" stopped))
        = `Bool true);
      started fixture 1;
      expect "only the new launch ran" (List.length (agent_pids fixture) = 1);
      expect "it runs under the new folder"
        (List.exists
           (fun line -> contains line "/accounts/b")
           (log_lines fixture)))

let () =
  host_argv := [| Sys.argv.(1) |];
  Alcotest.run
    ~argv:
      (Array.append
         [| Sys.argv.(0) |]
         (Array.sub Sys.argv 2 (Array.length Sys.argv - 2)))
    "ptyhost_agent_relaunch"
    [
      ( "stop_agent_if",
        [
          Alcotest.test_case "the agent restarts in the same terminal" `Slow
            same_terminal;
          Alcotest.test_case "an agent that ignores SIGHUP is killed" `Slow
            stubborn_agent_is_killed;
          Alcotest.test_case "refusals signal nothing" `Slow
            refusals_signal_nothing;
          Alcotest.test_case "bound agent mismatch signals nothing" `Slow
            bound_agent_refusal_signals_nothing;
          Alcotest.test_case "a shell without job control: nothing signalled"
            `Slow no_job_control_signals_nothing;
          Alcotest.test_case "a half-typed line is erased before the launch"
            `Slow half_typed_line_is_erased;
          Alcotest.test_case "input during stop never reaches the shell" `Slow
            input_during_stop_does_not_reach_shell;
          Alcotest.test_case "the new meta keeps the nonce" `Slow
            meta_keeps_the_nonce;
          Alcotest.test_case "a pending launch is dropped by a stop" `Slow
            pending_launch_is_dropped;
        ] );
    ]
