(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Black-box robustness of the native PTY host, given as the first argument:
   the path of its executable, taken as one path. Each case starts its own
   host in a private runtime directory. *)

open Ptyhost_blackbox

let host_argv = ref [||]

type fixture = {
  scratch : string;
  home : string;
  runtime : string;
  socket_path : string;
  shell : string;
  log : string;
}

let with_fixture script f =
  (* Canonical: the host refuses a runtime directory reached through a
     symbolic link, as the temporary directory is on macOS. *)
  let scratch =
    Filename.temp_dir
      ~temp_dir:(Test_scratch.short_temp_root ())
      "pty-robust-" ""
  in
  let fixture =
    {
      scratch;
      home = Filename.concat scratch "home";
      runtime = Filename.concat scratch "run";
      socket_path = Filename.concat scratch "run/session-mesh/ptyhost.sock";
      shell = Filename.concat scratch "session-program.sh";
      log = Filename.concat scratch "host.log";
    }
  in
  Unix.mkdir fixture.home 0o700;
  Unix.mkdir fixture.runtime 0o700;
  write_shell fixture.shell script;
  let session_pids = ref [] in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun pid ->
          try Unix.kill (-pid) Sys.sigkill
          with Unix.Unix_error (Unix.ESRCH, _, _) -> ())
        !session_pids;
      remove_tree scratch)
    (fun () -> f fixture session_pids)

let launch ?(argv_prefix = [||]) fixture =
  let log =
    Unix.openfile fixture.log
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_APPEND ]
      0o600
  in
  Fun.protect
    ~finally:(fun () -> Unix.close log)
    (fun () ->
      host
      @@ start_host ~stderr:log
           (Array.append argv_prefix !host_argv)
           ~home:fixture.home ~runtime:fixture.runtime ~shell:fixture.shell)

let with_host ?argv_prefix fixture f =
  let pid = launch ?argv_prefix fixture in
  Fun.protect
    ~finally:(fun () -> stop pid)
    (fun () ->
      wait_answering fixture.socket_path;
      f pid)

let sessions fixture =
  match request fixture.socket_path {|{"op":"list"}|} with
  | `List sessions -> sessions
  | _ -> failwith "list reply"

let member key json = Yojson.Basic.Util.member key json

let new_session fixture session_pids payload =
  let reply = request fixture.socket_path payload in
  expect
    ("session created: " ^ Yojson.Basic.to_string reply)
    (member "ok" reply = `Bool true);
  session_pids :=
    List.map
      (fun s -> Yojson.Basic.Util.to_int (member "pid" s))
      (sessions fixture);
  reply

let quiet_program = "#!/bin/sh\n: > \"$HOME/ready\"\nexec sleep 600\n"

let new_quiet fixture session_pids name =
  ignore
    (new_session fixture session_pids
       (Yojson.Basic.to_string
          (`Assoc
             [
               ("op", `String "new");
               ("name", `String name);
               ("cwd", `String fixture.home);
             ])))

(* Connect until the host logs an accept failure. A full listen backlog
   (EAGAIN) only means the host has not yet drained it: wait and retry rather
   than stop, so the host is driven to EMFILE whatever the machine speed. The
   attempt is bounded by a deadline and a connection cap. *)
let accept_failure_logged fixture =
  List.exists
    (fun line -> contains line "accept")
    (String.split_on_char '\n' (file_contents fixture.log))

let drive_to_accept_failure fixture idle =
  let deadline = Unix.gettimeofday () +. 10. in
  let cap = 400 in
  let count = ref 0 in
  while
    !count < cap
    && Unix.gettimeofday () < deadline
    && not (accept_failure_logged fixture)
  do
    let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
    Unix.set_nonblock socket;
    match Unix.connect socket (Unix.ADDR_UNIX fixture.socket_path) with
    | () ->
        idle := socket :: !idle;
        incr count
    | exception Unix.Unix_error ((Unix.EAGAIN | Unix.ECONNREFUSED), _, _) ->
        Unix.close socket;
        Unix.sleepf 0.03
  done

(* EMFILE: the host cannot accept while every descriptor is in use. It must
   keep its sessions and serve again once descriptors are free. *)
let accept_failure_keeps_serving () =
  with_fixture quiet_program (fun fixture session_pids ->
      let pid =
        launch fixture
          ~argv_prefix:
            [| "/bin/sh"; "-c"; "ulimit -n 48 && exec \"$@\""; "sh" |]
      in
      Fun.protect
        ~finally:(fun () -> stop pid)
        (fun () ->
          wait_answering fixture.socket_path;
          new_quiet fixture session_pids "kept";
          let idle = ref [] in
          Fun.protect
            ~finally:(fun () -> List.iter Unix.close !idle)
            (fun () ->
              drive_to_accept_failure fixture idle;
              Unix.sleepf 1.;
              match exited pid with
              | None -> ()
              | Some _ ->
                  failwith
                    ("the host ended when out of descriptors: "
                   ^ file_contents fixture.log));
          ignore
            (wait_until "host serving again" 10. (fun () ->
                 try
                   match sessions fixture with
                   | [ session ] -> member "name" session = `String "kept"
                   | _ -> false
                 with
                 | Unix.Unix_error ((Unix.EAGAIN | Unix.ECONNREFUSED), _, _) ->
                   false));
          match
            List.find_opt
              (fun line -> contains line "accept")
              (String.split_on_char '\n' (file_contents fixture.log))
          with
          | Some line -> print_endline line
          | None -> failwith "the accept failure is not logged"))

(* A host killed with SIGKILL leaves its socket file behind. *)
let stale_socket_is_replaced () =
  with_fixture quiet_program (fun fixture _ ->
      let directory = Filename.dirname fixture.socket_path in
      Unix.mkdir directory 0o700;
      let stale = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
      Unix.bind stale (Unix.ADDR_UNIX fixture.socket_path);
      Unix.close stale;
      with_host fixture (fun pid ->
          expect "the host serves" (exited pid = None)))

(* A second host must not take the socket of one that still answers. *)
let live_socket_is_not_taken () =
  with_fixture quiet_program (fun fixture session_pids ->
      with_host fixture (fun first ->
          new_quiet fixture session_pids "first";
          let second = launch fixture in
          let status =
            Fun.protect
              ~finally:(fun () -> stop second)
              (fun () ->
                ignore
                  (wait_until "second host refused" 10. (fun () ->
                       match exited second with
                       | None -> false
                       | Some status ->
                           expect "refusal is a failure"
                             (status <> Unix.WEXITED 0);
                           true)))
          in
          ignore status;
          expect "first host still running" (exited first = None);
          match sessions fixture with
          | [ session ] ->
              expect "first host still owns the socket"
                (member "name" session = `String "first")
          | _ -> failwith "the first host's session is listed"))

(* An ignored SIGPIPE stays ignored across exec: a session pipeline would
   print "Broken pipe" instead of ending quietly. The host is started with
   SIGPIPE ignored, as systemd does by default. *)
let sessions_start_with_default_sigpipe () =
  let program =
    "#!/bin/sh\n\
     yes 2>\"$HOME/yes.err\" | head -1 >/dev/null\n\
     : > \"$HOME/ready\"\n\
     exec sleep 600\n"
  in
  with_fixture program (fun fixture session_pids ->
      let previous = Sys.signal Sys.sigpipe Sys.Signal_ignore in
      let pid =
        Fun.protect
          ~finally:(fun () -> Sys.set_signal Sys.sigpipe previous)
          (fun () -> launch fixture)
      in
      Fun.protect
        ~finally:(fun () -> stop pid)
        (fun () ->
          wait_answering fixture.socket_path;
          new_quiet fixture session_pids "pipe";
          ignore
            (wait_until "session program ran" 10. (fun () ->
                 Sys.file_exists (Filename.concat fixture.home "ready")));
          let errors = file_contents (Filename.concat fixture.home "yes.err") in
          if errors <> "" then
            Alcotest.failf "the session ignored SIGPIPE: %S" errors))

(* [start_if] types its command once the program has drawn a prompt and gone
   quiet, as [new] does, not into a program that has not started reading. *)
let start_if_waits_for_a_quiet_prompt () =
  let program =
    "#!/bin/sh\n\
     sleep 0.5\n\
     printf 'prompt> '\n\
     date +%s%N > \"$HOME/prompted\"\n\
     read line\n\
     date +%s%N > \"$HOME/answered\"\n\
     echo \"$line\" > \"$HOME/line\"\n\
     exec sleep 600\n"
  in
  with_fixture program (fun fixture session_pids ->
      with_host fixture (fun _ ->
          new_quiet fixture session_pids "typed";
          let created =
            match sessions fixture with
            | [ session ] -> member "created" session
            | _ -> failwith "one session"
          in
          let reply =
            request fixture.socket_path
              (Yojson.Basic.to_string
                 (`Assoc
                    [
                      ("op", `String "start_if");
                      ("name", `String "typed");
                      ("created", created);
                      ("command", `String "hello");
                    ]))
          in
          expect "start_if accepted" (member "ok" reply = `Bool true);
          let line = Filename.concat fixture.home "line" in
          ignore
            (wait_until "command typed" 15. (fun () ->
                 Sys.file_exists line && file_contents line <> ""));
          expect "exact command" (file_contents line = "hello\n");
          let time name =
            Int64.of_string
              (String.trim (file_contents (Filename.concat fixture.home name)))
          in
          let waited =
            Int64.to_float (Int64.sub (time "answered") (time "prompted"))
            /. 1e9
          in
          if waited < 0.6 then
            Alcotest.failf "typed %.3f s after the prompt, before it was quiet"
              waited))

(* Python's json resolves a repeated key to its last value, at every depth;
   the legacy operations must read the same request the same way. *)
let duplicate_keys_resolve_to_the_last () =
  with_fixture quiet_program (fun fixture session_pids ->
      with_host fixture (fun _ ->
          let cwd = Yojson.Basic.to_string (`String fixture.home) in
          ignore
            (new_session fixture session_pids
               (Printf.sprintf
                  {|{"op":"new","name":"first","cwd":%s,"meta":{"k":1,"k":2},"name":"second"}|}
                  cwd));
          (match sessions fixture with
          | [ session ] ->
              expect "last name wins" (member "name" session = `String "second");
              expect "last nested value wins"
                (member "meta" session = `Assoc [ ("k", `Int 2) ])
          | _ -> failwith "one session");
          let reply =
            request fixture.socket_path
              {|{"op":"kill","name":"absent","name":"second"}|}
          in
          expect "kill reads the last name" (member "ok" reply = `Bool true)))

(* [start_if] and [notify_if] read a repeated key with the last value
   winning, so these requests are valid rather than refused. The wakes of
   this file carry an [idle_since] in 2100, later than any input, so they
   exercise the other gates; tests/wake-idle-gate.test.ts covers that one. *)
let wake_requests_resolve_repeated_keys () =
  with_fixture quiet_program (fun fixture session_pids ->
      with_host fixture (fun _ ->
          new_quiet fixture session_pids "repeated";
          let created =
            match sessions fixture with
            | [ session ] -> Yojson.Basic.to_string (member "created" session)
            | _ -> failwith "one session"
          in
          let wake =
            request fixture.socket_path
              (Printf.sprintf
                 {|{"op":"notify_if","name":"repeated","created":%s,"notification_id":"wake_notification_0001","count":0,"count":1,"through_seq":1,"agent":"codex","idle_since":4102444800.0}|}
                 created)
          in
          expect
            ("notify_if reads the last count: " ^ Yojson.Basic.to_string wake)
            (wake
            = `Assoc
                [
                  ("ok", `Bool false);
                  ("reason", `String "unsupported_foreground");
                ]);
          let start =
            request fixture.socket_path
              (Printf.sprintf
                 {|{"op":"start_if","name":"repeated","created":%s,"command":"","command":"true"}|}
                 created)
          in
          expect
            ("start_if reads the last command: " ^ Yojson.Basic.to_string start)
            (start = `Assoc [ ("ok", `Bool true) ])))

(* Two hosts started together on a stale socket: one serves, the other logs
   that it is not starting and exits with status 1. Without the host lock,
   both could find the socket stale and the later one unlink the socket the
   earlier one had just bound. *)
let hosts_started_together_leave_one_serving () =
  for _ = 1 to 5 do
    with_fixture quiet_program (fun fixture _ ->
        Unix.mkdir (Filename.dirname fixture.socket_path) 0o700;
        let stale = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
        Unix.bind stale (Unix.ADDR_UNIX fixture.socket_path);
        Unix.close stale;
        let first = launch fixture and second = launch fixture in
        Fun.protect
          ~finally:(fun () -> List.iter stop [ first; second ])
          (fun () ->
            ignore
              (wait_until "one host refused" 10. (fun () ->
                   exited first <> None || exited second <> None));
            Unix.sleepf 0.3;
            (match (exited first, exited second) with
            | Some (Unix.WEXITED 1), None | None, Some (Unix.WEXITED 1) -> ()
            | _ -> failwith "exactly one host must refuse, with status 1");
            expect "the refusal is logged"
              (contains (file_contents fixture.log) "not starting");
            expect "the remaining host answers" (answering fixture.socket_path)))
  done

(* A background job that keeps the terminal open does not keep the session:
   its program is reaped at once, and the session ends shortly after. *)
let background_job_does_not_hold_the_session () =
  (* With job control the job gets its own process group, as in an
     interactive shell: the hangup at the program's exit, sent to the
     foreground group, does not reach it, and it keeps the terminal open.
     The program waits for the job's pid to be recorded. *)
  let program =
    "#!/bin/sh\n\
     set -m\n\
     sleep 300 &\n\
     echo $! > \"$HOME/job.tmp\" && mv \"$HOME/job.tmp\" \"$HOME/job\"\n\
     exit 3\n"
  in
  with_fixture program (fun fixture session_pids ->
      with_host fixture (fun _ ->
          new_quiet fixture session_pids "orphan";
          let pid =
            match !session_pids with
            | [ pid ] -> pid
            | _ -> failwith "one session"
          in
          let job_file = Filename.concat fixture.home "job" in
          ignore
            (wait_until "job started" 10. (fun () -> Sys.file_exists job_file));
          let job = int_of_string (String.trim (file_contents job_file)) in
          session_pids := job :: !session_pids;
          ignore
            (wait_until "session gone from the listing" 5. (fun () ->
                 sessions fixture = []));
          (* [kill pid 0] still succeeds on a zombie. *)
          expect "the program was reaped" (not (alive pid));
          expect "kill of the ended session"
            (member "ok"
               (request fixture.socket_path {|{"op":"kill","name":"orphan"}|})
            = `Bool false)))

(* SIGHUP series (7.75 s), then SIGKILL 4 s after its last signal. *)
let kill_ends_a_program_ignoring_sighup () =
  let program =
    "#!/bin/sh\n\
     trap '' HUP\n\
     : > \"$HOME/ready\"\n\
     while :; do sleep 0.05; done\n"
  in
  with_fixture program (fun fixture session_pids ->
      with_host fixture (fun _ ->
          new_quiet fixture session_pids "deaf";
          ignore
            (wait_until "program started" 10. (fun () ->
                 Sys.file_exists (Filename.concat fixture.home "ready")));
          expect "kill accepted"
            (member "ok"
               (request fixture.socket_path {|{"op":"kill","name":"deaf"}|})
            = `Bool true);
          let elapsed =
            wait_until "session gone from the listing" 20. (fun () ->
                sessions fixture = [])
          in
          if elapsed < 11. then
            Alcotest.failf "ended %.1f s after kill, before the SIGKILL" elapsed))

let frame kind payload =
  let head = Bytes.create 5 in
  Bytes.set head 0 kind;
  Bytes.set_int32_be head 1 (Int32.of_int (String.length payload));
  Bytes.to_string head ^ payload

let write_all socket message =
  expect "frame written whole"
    (Unix.write_substring socket message 0 (String.length message)
    = String.length message)

(* An attachment that asserts a dirty lease for [client_id]. *)
let attach_dirty fixture name client_id =
  let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Unix.setsockopt_float socket Unix.SO_RCVTIMEO 5.;
  Unix.connect socket (Unix.ADDR_UNIX fixture.socket_path);
  write_all socket
    (frame 'C'
       (Yojson.Basic.to_string
          (`Assoc [ ("op", `String "attach"); ("name", `String name) ])));
  let head = read_exactly socket 5 in
  let reply =
    read_exactly socket (Int32.to_int (Bytes.get_int32_be head 1))
    |> Bytes.to_string |> Yojson.Basic.from_string
  in
  expect "attached" (Bytes.get head 0 = 'C' && member "ok" reply = `Bool true);
  write_all socket
    (frame 'H'
       (Yojson.Basic.to_string
          (`Assoc [ ("client_id", `String client_id); ("dirty", `Bool true) ])));
  socket

(* A dirty lease holds while a connection of its client is attached, then
   [MESH_PTYHOST_HUMAN_LEASE_GRACE] seconds after the last one closes. *)
let abandoned_lease_expires () =
  with_fixture quiet_program (fun fixture session_pids ->
      with_host
        ~argv_prefix:[| "/usr/bin/env"; "MESH_PTYHOST_HUMAN_LEASE_GRACE=1" |]
        fixture (fun _ ->
          new_quiet fixture session_pids "leased";
          let created =
            match sessions fixture with
            | [ session ] -> Yojson.Basic.to_string (member "created" session)
            | _ -> failwith "one session"
          in
          let reason () =
            member "reason"
              (request fixture.socket_path
                 (Printf.sprintf
                    {|{"op":"notify_if","name":"leased","created":%s,"notification_id":"wake_notification_0001","count":1,"through_seq":1,"agent":"codex","idle_since":4102444800.0}|}
                    created))
          in
          let client_id = "browser_client_00000001" in
          let first = attach_dirty fixture "leased" client_id in
          ignore
            (wait_until "lease recorded" 5. (fun () ->
                 reason () = `String "human_dirty"));
          Unix.sleepf 1.5;
          expect "held while its client is attached"
            (reason () = `String "human_dirty");
          Unix.close first;
          Unix.sleepf 0.2;
          expect "survives a disconnect" (reason () = `String "human_dirty");
          Unix.sleepf 1.5;
          expect "gone after the grace"
            (reason () = `String "unsupported_foreground")))

(* The agent runs in the foreground group of the session: the program is an
   executable named [claude], which becomes the session's foreground process,
   so a wake for [claude] passes the foreground gate and one for [codex] does
   not. *)
let check_foreground_agent ?(invalid = []) script ~accepted ~refused =
  with_fixture script (fun fixture session_pids ->
      with_host fixture (fun _ ->
          new_session fixture session_pids
            (Yojson.Basic.to_string
               (`Assoc
                  [
                    ("op", `String "new");
                    ("name", `String "agent");
                    ("cwd", `String fixture.home);
                  ]))
          |> ignore;
          ignore
            (wait_until "agent started" 5. (fun () ->
                 Sys.file_exists (Filename.concat fixture.home "ready")));
          let created =
            match sessions fixture with
            | [ session ] -> Yojson.Basic.to_string (member "created" session)
            | _ -> failwith "one session"
          in
          let reply agent =
            request fixture.socket_path
              (Printf.sprintf
                 {|{"op":"notify_if","name":"agent","created":%s,"notification_id":"wake_notification_0001","count":1,"through_seq":1,"agent":"%s","idle_since":4102444800.0}|}
                 created agent)
          in
          let wake agent = member "reason" (reply agent) in
          (* An agent the host does not wake (the web server's decision: Antigravity
             and Copilot are not woken by typing) is a malformed request. *)
          List.iter
            (fun agent ->
              expect
                (agent ^ " is not an agent a wake may name")
                (member "error" (reply agent) <> `Null))
            invalid;
          (* A refused wake records nothing; the accepted one does, so it
             comes last. *)
          List.iter
            (fun agent ->
              expect
                (agent ^ " is not the foreground agent")
                (wake agent = `String "unsupported_foreground"))
            refused;
          ignore
            (wait_until (accepted ^ " detected in the foreground") 5. (fun () ->
                 wake accepted <> `String "unsupported_foreground"))))

let foreground_agent_is_detected () =
  check_foreground_agent
    "#!/bin/sh\n\
     ln -s \"$(command -v sleep)\" \"$HOME/claude\"\n\
     : > \"$HOME/ready\"\n\
     exec \"$HOME/claude\" 600\n"
    ~accepted:"claude" ~refused:[ "codex" ]

(* The comm is [sleep]; only argv[0] names the agent, and only its basename
   counts, in full. *)
let foreground_agent_is_detected_by_argv0 () =
  check_foreground_agent
    "#!/bin/bash\n: > \"$HOME/ready\"\nexec -a /some/dir/claude sleep 600\n"
    ~accepted:"claude" ~refused:[ "codex" ]

let foreground_argv0_must_match_exactly () =
  check_foreground_agent
    "#!/bin/bash\n: > \"$HOME/ready\"\nexec -a /x/claude-wrapper sleep 600\n"
    ~accepted:"claude-wrapper" ~refused:[ "claude"; "codex" ]

(* `vibe` execs its bundled interface, which runs as vibe-rs: a wake for [vibe]
   finds it in the foreground. *)
let foreground_vibe_runs_as_vibe_rs () =
  check_foreground_agent
    "#!/bin/sh\n\
     ln -s \"$(command -v sleep)\" \"$HOME/vibe-rs\"\n\
     : > \"$HOME/ready\"\n\
     exec \"$HOME/vibe-rs\" 600\n"
    ~accepted:"vibe" ~refused:[ "claude"; "codex" ]

(* Gemini is a node script: argv[0] is node and the first word that is not an
   option names the script. Antigravity and Copilot are never a wake target. *)
let foreground_gemini_is_a_node_script () =
  check_foreground_agent ~invalid:[ "agy"; "copilot" ]
    "#!/bin/bash\n\
     printf '#!/bin/sh\\nsleep 600\\n' > \"$HOME/gemini.js\"\n\
     : > \"$HOME/ready\"\n\
     exec -a node /bin/sh \"$HOME/gemini.js\"\n"
    ~accepted:"gemini" ~refused:[ "claude"; "vibe" ]

let () =
  let argv = Sys.argv in
  if Array.length argv < 2 then
    invalid_arg
      "usage: ptyhost_robustness_test HOST_EXECUTABLE [alcotest options]";
  host_argv := [| argv.(1) |];
  Alcotest.run
    ~argv:
      (Array.append [| argv.(0) |] (Array.sub argv 2 (Array.length argv - 2)))
    "PTY host robustness"
    [
      ( "host",
        [
          Alcotest.test_case "an accept failure keeps the host serving" `Quick
            accept_failure_keeps_serving;
          Alcotest.test_case "a stale socket is replaced" `Quick
            stale_socket_is_replaced;
          Alcotest.test_case "a live host's socket is not taken" `Quick
            live_socket_is_not_taken;
          Alcotest.test_case "hosts started together leave one serving" `Quick
            hosts_started_together_leave_one_serving;
        ] );
      ( "sessions",
        [
          Alcotest.test_case "sessions start with the default SIGPIPE" `Quick
            sessions_start_with_default_sigpipe;
          Alcotest.test_case "start_if waits for a quiet prompt" `Quick
            start_if_waits_for_a_quiet_prompt;
          Alcotest.test_case "repeated keys resolve to the last value" `Quick
            duplicate_keys_resolve_to_the_last;
          Alcotest.test_case "start_if and notify_if resolve repeated keys"
            `Quick wake_requests_resolve_repeated_keys;
          Alcotest.test_case "the foreground agent is detected" `Quick
            foreground_agent_is_detected;
          Alcotest.test_case "the agent is detected by argv[0]" `Slow
            foreground_agent_is_detected_by_argv0;
          Alcotest.test_case "argv[0] must match the agent exactly" `Slow
            foreground_argv0_must_match_exactly;
          Alcotest.test_case "vibe is the foreground program vibe-rs" `Slow
            foreground_vibe_runs_as_vibe_rs;
          Alcotest.test_case "gemini is a node script; agy and copilot are no wake target" `Slow
            foreground_gemini_is_a_node_script;
          Alcotest.test_case "a background job does not hold the session" `Quick
            background_job_does_not_hold_the_session;
          Alcotest.test_case "kill ends a program ignoring SIGHUP" `Quick
            kill_ends_a_program_ignoring_sighup;
          Alcotest.test_case "an abandoned input lease expires" `Quick
            abandoned_lease_expires;
        ] );
    ]
