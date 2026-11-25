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

type fixture = { home : string; socket_path : string; agent : string;
                 mutable restart_host : unit -> unit }

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

let with_host ?(grace = "0.5") ?lease_grace f =
  let scratch = Test_scratch.private_directory "pty-relaunch-" in
  let fixture =
    {
      home = Filename.concat scratch "home";
      socket_path = Filename.concat scratch "run/session-mesh/ptyhost.sock";
      agent =
        Filename.concat scratch "bin/claude"
        ^ " "
        ^ Filename.concat scratch "bin/agent.sh";
      restart_host = (fun () -> failwith "host not started");
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
  let launch () =
    host (start_host
          ~environment:([ "MESH_PTYHOST_AGENT_STOP_GRACE=" ^ grace ]
            @ Option.fold ~none:[] ~some:(fun seconds ->
                [ "MESH_PTYHOST_HUMAN_LEASE_GRACE=" ^ seconds ]) lease_grace)
         !host_argv ~home:fixture.home
         ~runtime:(Filename.concat scratch "run")
         ~shell) in
  let pid = ref (launch ()) in
  fixture.restart_host <- (fun () ->
      stop !pid;
      pid := launch ();
      wait_answering fixture.socket_path);
  Fun.protect
    ~finally:(fun () ->
      let agents = agent_pids fixture in
      List.iter
        (fun pid ->
          try Unix.kill (-pid) Sys.sigkill with Unix.Unix_error _ -> ())
        agents;
      stop !pid;
      remove_tree scratch)
    (fun () ->
      wait_answering fixture.socket_path;
      f fixture)

let send fixture fields =
  request fixture.socket_path (Yojson.Basic.to_string (`Assoc fields))

let legacy_duplicate_fields_with_v2_marker () =
  with_host (fun fixture ->
    List.iter (fun name ->
      let reply = send fixture [ ("op", `String "new"); ("name", `String name);
                                ("cwd", `String fixture.home) ] in
      expect "session created" (member "ok" reply = `Bool true)) ["first"; "second"];
    let refused = request fixture.socket_path
        {|{"op":"kill","op":"attach","name":"first","input_ack_v2":{}}|} in
    expect "ambiguous v2 attach rejected" (member "ok" refused <> `Bool true);
    (match request fixture.socket_path {|{"op":"list"}|} with
     | `List sessions -> expect "neither session stopped by ambiguous attach" (List.length sessions = 2)
     | _ -> failwith "session listing");
    let reply = request fixture.socket_path
        {|{"op":"attach","op":"kill","name":"first","name":"second","input_ack_v2":{}}|} in
    expect "legacy kill accepted" (member "ok" reply = `Bool true);
    ignore (wait_until "last named session ended" 5. (fun () ->
      match request fixture.socket_path {|{"op":"list"}|} with
      | `List sessions ->
          List.exists (fun s -> member "name" s = `String "first") sessions
          && not (List.exists (fun s -> member "name" s = `String "second") sessions)
      | _ -> false));
    let created = send fixture [("op", `String "new"); ("name", `String "third");
                                ("cwd", `String fixture.home)] in
    expect "third session created" (member "ok" created = `Bool true);
    let legacy = request fixture.socket_path
        {|{"op":"kill","name":"first","name":"third"}|} in
    expect "ordinary legacy kill accepted" (member "ok" legacy = `Bool true);
    ignore (wait_until "ordinary legacy last-wins" 5. (fun () ->
      match request fixture.socket_path {|{"op":"list"}|} with
      | `List sessions ->
          List.exists (fun s -> member "name" s = `String "first") sessions
          && not (List.exists (fun s -> member "name" s = `String "third") sessions)
      | _ -> false)))

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
    ?fence fixture created =
  send fixture
    ([
      ("op", `String "start_if");
      ("name", `String "relaunch");
      ("created", created);
      ("command", `String ("env CLAUDE_CONFIG_DIR=/accounts/b " ^ fixture.agent));
      ("meta", `Assoc meta);
    ] @ Option.fold ~none:[] ~some:(fun id -> [("fence_id", `String id)]) fence)

let switch_fence fixture op created fence_id =
  let receipt =
    match send fixture [ ("op", `String "list_bound") ] with
    | `List [ session ] -> member "creation_receipt" session
    | _ -> failwith "bound listing"
  in
  send fixture
    [ ("op", `String op); ("name", `String "relaunch");
      ("created", created); ("creation_receipt", receipt);
      ("fence_id", `String fence_id) ]

let fence_id = "switch-owner-0123456789abcdef"

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

let write_frame socket kind payload =
  let head = Bytes.create 5 in
  Bytes.set head 0 kind;
  Bytes.set_int32_be head 1 (Int32.of_int (String.length payload));
  let data = Bytes.to_string head ^ payload in
  expect "whole frame sent"
    (Unix.write_substring socket data 0 (String.length data)
     = String.length data)

let next_frame socket =
  let head = read_exactly socket 5 in
  (Bytes.get head 0,
   Bytes.to_string (read_exactly socket
     (Int32.to_int (Bytes.get_int32_be head 1))))

let next_input_ack socket =
  let rec loop remaining =
    if remaining = 0 then failwith "missing native input ACK"
    else
      let kind, payload = next_frame socket in
      if kind = 'C' && contains payload "input_ack" then payload
      else loop (remaining - 1)
  in
  loop 100

let next_control socket =
  let rec loop remaining =
    if remaining = 0 then failwith "missing native control frame"
    else let kind, payload = next_frame socket in
      if kind = 'C' then payload else loop (remaining - 1)
  in loop 100

let ack_attachment fixture created id =
  let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Unix.setsockopt_float socket Unix.SO_RCVTIMEO 3.;
  Unix.connect socket (Unix.ADDR_UNIX fixture.socket_path);
  write_frame socket 'C'
    (Yojson.Basic.to_string (`Assoc
       [ ("op", `String "attach"); ("name", `String "relaunch");
         ("rows", `Int 24); ("cols", `Int 80);
         ("input_ack_created", created); ("input_ack_id", `String id) ]));
  socket

let v2_attachment ?(attach_fields = []) fixture fields =
  let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Unix.setsockopt_float socket Unix.SO_RCVTIMEO 3.;
  Unix.connect socket (Unix.ADDR_UNIX fixture.socket_path);
  write_frame socket 'C'
    (Yojson.Basic.to_string (`Assoc
       ([ ("op", `String "attach"); ("name", `String "relaunch");
          ("input_ack_v2", `Assoc fields) ] @ attach_fields)));
  let greeting = Yojson.Basic.from_string (snd (next_frame socket)) in
  if member "ok" greeting = `Bool true then ignore (next_frame socket);
  (socket, greeting)

let v2_new fixture created =
  v2_attachment fixture
    [ ("mode", `String "new"); ("created", created) ]

(* "attached = 0" is updated in the host's handler before accept_fork closes
   its flow. Wait for socket EOF as well before reusing a connection budget. *)
let close_attachment socket =
  Fun.protect
    ~finally:(fun () -> Unix.close socket)
    (fun () ->
      Unix.shutdown socket Unix.SHUTDOWN_SEND;
      let buffer = Bytes.create 4096 in
      let rec drain () =
        if Unix.read socket buffer 0 (Bytes.length buffer) <> 0 then drain ()
      in
      drain ())

let v2_resume fixture created ack =
  v2_attachment fixture
    [ ("mode", `String "resume"); ("created", created);
      ("slot", member "slot" ack); ("generation", member "generation" ack);
      ("actor_nonce", member "actor_nonce" ack) ]

let v2_input socket seq data =
  let head = Bytes.create 4 in
  Bytes.set_int32_be head 0 (Int32.of_int seq);
  write_frame socket 'I' (Bytes.to_string head ^ data);
  Yojson.Basic.from_string (next_input_ack socket)

let resize socket ~mode rows cols =
  write_frame socket 'R' (Yojson.Basic.to_string (`Assoc
    [ ("rows", `Int rows); ("cols", `Int cols);
      ("size", `String mode) ]))

let rec next_size socket =
  let kind, payload = next_frame socket in
  if kind = 'S' then Yojson.Basic.from_string payload else next_size socket

(* The input refusal is ordered after preceding frames sent by this watcher.
   Reject any size notification before that barrier rather than timing out. *)
let fenced_input_without_size socket =
  let head = Bytes.create 4 in
  Bytes.set_int32_be head 0 1l;
  write_frame socket 'I' (Bytes.to_string head ^ "barrier");
  let rec await_ack remaining =
    if remaining = 0 then failwith "missing fenced watcher input ACK";
    let kind, payload = next_frame socket in
    if kind = 'S' then failwith "size frame after fenced resize";
    if kind = 'C' && contains payload "input_ack" then
      expect "watcher barrier refused by fence"
        (member "reason" (Yojson.Basic.from_string payload)
         = `String "switch_input_fenced")
    else await_ack (remaining - 1)
  in
  await_ack 100

let size_claim = [ ("size", `String "claim");
                   ("rows", `Int 24); ("cols", `Int 80) ]

let size_is label frame rows cols owner =
  expect label
    (member "rows" frame = `Int rows
     && member "cols" frame = `Int cols
     && member "owner" frame = `String owner)

let acknowledged_v2_resize_fences () =
  with_host (fun fixture ->
    let created = member "created" (new_agent fixture) in
    let owner, reply = v2_attachment ~attach_fields:size_claim fixture
      [ ("mode", `String "new"); ("created", created) ] in
    expect "v2 size owner bound" (member "input_ack_v2" reply <> `Null);
    size_is "owner's initial geometry" (next_size owner) 24 80 "you";
    let watcher, reply = v2_attachment ~attach_fields:size_claim fixture
      [ ("mode", `String "new"); ("created", created) ] in
    expect "watcher bound" (member "input_ack_v2" reply <> `Null);
    size_is "watcher does not own" (next_size watcher) 24 80 "other";
    size_is "owner informed of watcher" (next_size owner) 24 80 "you";
    ignore (wait_until "acquire clean size-owner fence" 3. (fun () ->
      member "ok" (switch_fence fixture "switch_input_acquire" created fence_id)
      = `Bool true));
    resize owner ~mode:"take" 39 101;
    expect "owner resize processed before fence release"
      (member "reason" (v2_input owner 1 "barrier")
       = `String "switch_input_fenced");
    fenced_input_without_size watcher;
    expect "release fence" (member "ok"
      (switch_fence fixture "switch_input_release" created fence_id)
      = `Bool true);
    resize owner ~mode:"take" 33 95;
    size_is "released size and owner" (next_size owner) 33 95 "you";
    size_is "watcher sees only released size" (next_size watcher)
      33 95 "other";
    Unix.close owner;
    Unix.close watcher)

let acknowledged_v2_stale_resize () =
  with_host (fun fixture ->
    let created = member "created" (new_agent fixture) in
    let old, reply = v2_attachment ~attach_fields:size_claim fixture
      [ ("mode", `String "new"); ("created", created) ] in
    expect "old size owner bound" (member "input_ack_v2" reply <> `Null);
    size_is "old owner" (next_size old) 24 80 "you";
    let fresh = member "created" (stop_agent fixture created) in
    expect "stop advanced epoch" (fresh <> created);
    let current, reply = v2_attachment ~attach_fields:size_claim fixture
      [ ("mode", `String "new"); ("created", fresh) ] in
    expect "fresh actor bound" (member "input_ack_v2" reply <> `Null);
    size_is "old owner still attached" (next_size current) 24 80 "other";
    size_is "old owner told of fresh watcher" (next_size old) 24 80 "you";
    resize old ~mode:"take" 39 101;
    expect "stale resize processed before geometry check"
      (member "reason" (v2_input old 1 "stale")
       = `String "stale_incarnation");
    resize current ~mode:"claim" 24 80;
    size_is "stale resize did not change geometry or size ownership"
      (next_size current) 24 80 "other";
    size_is "old owner remains before current takeover"
      (next_size old) 24 80 "you";
    resize current ~mode:"take" 33 95;
    size_is "current actor takes size" (next_size current) 33 95 "you";
    size_is "old actor becomes follower" (next_size old) 33 95 "other";
    resize old ~mode:"take" 44 99;
    expect "second stale resize processed before geometry check"
      (member "reason" (v2_input old 2 "stale")
       = `String "stale_incarnation");
    resize current ~mode:"claim" 33 95;
    size_is "stale actor cannot take ownership back"
      (next_size current) 33 95 "you";
    Unix.close old;
    Unix.close current)

let acknowledged_v2_revoked_dirty () =
  with_host ~lease_grace:"1.5" (fun fixture ->
    let created = member "created" (new_agent fixture) in
    let old, reply = v2_new fixture created in
    let actor = member "input_ack_v2" reply in
    expect "human input admitted"
      (member "input_ack" (v2_input old 1 "a") = `Bool true);
    let fresh = member "created" (stop_agent fixture created) in
    Unix.sleepf 0.4;
    expect "old attached actor's dirty lease does not expire on stop"
      (member "reason"
        (switch_fence fixture "switch_input_acquire" fresh fence_id)
       = `String "legacy_attachment");
    write_frame old 'H' (Yojson.Basic.to_string (`Assoc
      [ ("slot", member "slot" actor);
        ("generation", member "generation" actor);
        ("dirty", `Bool false) ]));
    Unix.close old;
    ignore (wait_until "old dirty actor detached" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    expect "old epoch H did not clear an unknown dirty draft"
      (member "reason"
        (switch_fence fixture "switch_input_acquire" fresh fence_id)
       = `String "input_pending");
    ignore (wait_until "disconnected old dirty lease has bounded grace" 4.
      (fun () -> member "ok"
        (switch_fence fixture "switch_input_acquire" fresh fence_id)
        = `Bool true));
    expect "release" (member "ok"
      (switch_fence fixture "switch_input_release" fresh fence_id)
      = `Bool true))

let acknowledged_v2 () =
  with_host (fun fixture ->
    let created = member "created" (new_agent fixture) in
    let socket, greeting = v2_new fixture created in
    expect "v2 advertised on successful attach"
      (contains (Yojson.Basic.to_string greeting) "acknowledged_input_v2");
    let ack = member "input_ack_v2" greeting in
    expect "host assigns a bounded slot and a generation"
      (match (member "slot" ack, member "generation" ack) with
       | `Int slot, `Int generation -> slot >= 0 && slot < 64 && generation > 0
       | _ -> false);
    expect "host mints lowercase 128-bit actor nonce without receipt"
      (match member "actor_nonce" ack with
       | `String nonce ->
           String.length nonce = 32
           && String.for_all
                (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false) nonce
           && member "creation_receipt" ack = `Null
       | _ -> false);
    expect "accepted input" (member "input_ack" (v2_input socket 1 "a") = `Bool true);
    Unix.close socket;
    ignore (wait_until "v2 detach" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    let resumed, resumed_reply = v2_resume fixture created ack in
    expect "matching generation resumes"
      (member "input_ack_v2" resumed_reply = ack);
    expect "exact duplicate ACKed without enqueue"
      (member "input_ack" (v2_input resumed 1 "a") = `Bool true);
    expect "changed duplicate rejected"
      (member "reason" (v2_input resumed 1 "b") = `String "sequence_conflict");
    expect "stale sequence rejected"
      (member "reason" (v2_input resumed 0 "a") = `String "invalid_frame");
    write_frame resumed 'H' (Yojson.Basic.to_string (`Assoc
      [ ("slot", member "slot" ack); ("generation", member "generation" ack);
        ("dirty", `Bool false) ]));
    ignore (wait_until "v2 clean lease" 3. (fun () ->
      member "ok" (switch_fence fixture "switch_input_acquire" created fence_id)
      = `Bool true));
    expect "fenced exact retry ACKed"
      (member "input_ack" (v2_input resumed 1 "a") = `Bool true);
    expect "fenced new input refused"
      (member "reason" (v2_input resumed 2 "unadmitted")
       = `String "switch_input_fenced");
    expect "fenced changed retry refused"
      (member "reason" (v2_input resumed 1 "changed")
       = `String "switch_input_fenced");
    Unix.close resumed;
    ignore (wait_until "fenced actor detached" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    let resumed, resumed_reply = v2_resume fixture created ack in
    expect "previous actor may resume while fenced"
      (member "input_ack_v2" resumed_reply = ack);
    expect "ACK-lost retransmission after reconnect while fenced"
      (member "input_ack" (v2_input resumed 1 "a") = `Bool true);
    expect "release" (member "ok"
      (switch_fence fixture "switch_input_release" created fence_id)
      = `Bool true);
    Unix.close resumed;
    ignore (wait_until "v2 clean detach" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    let reused, next = v2_new fixture created in
    let next_ack = member "input_ack_v2" next in
    expect "unused slot chosen with distinct generation"
      (member "slot" next_ack = `Int 1
       && member "generation" next_ack <> member "generation" ack
       && member "actor_nonce" next_ack <> member "actor_nonce" ack);
    expect "new generation starts at sequence one"
      (member "input_ack" (v2_input reused 1 "b") = `Bool true);
    write_frame reused 'H' (Yojson.Basic.to_string (`Assoc
      [ ("slot", member "slot" next_ack);
        ("generation", member "generation" next_ack);
        ("dirty", `Bool false) ]));
    Unix.close reused;
    ignore (wait_until "current v2 actor inactive before nonce checks" 3.
      (fun () -> member "attached" (the_session fixture) = `Int 0));
    let wrong_nonce =
      match member "actor_nonce" next_ack with
      | `String nonce ->
          let changed = Bytes.of_string nonce in
          Bytes.set changed 0 (if nonce.[0] = '0' then '1' else '0');
          Bytes.to_string changed
      | _ -> failwith "missing actor nonce"
    in
    let wrong, denied = v2_attachment fixture
      [ ("mode", `String "resume"); ("created", created);
        ("slot", member "slot" next_ack);
        ("generation", member "generation" next_ack);
        ("actor_nonce", `String wrong_nonce) ] in
    expect "wrong nonce cannot bind current slot/generation"
      (member "ok" denied <> `Bool true);
    Unix.close wrong;
    let missing, denied = v2_attachment fixture
      [ ("mode", `String "resume"); ("created", created);
        ("slot", member "slot" next_ack);
        ("generation", member "generation" next_ack) ] in
    expect "resume without nonce refused"
      (member "ok" denied <> `Bool true);
    Unix.close missing;
    let supplied, denied = v2_attachment fixture
      [ ("mode", `String "new"); ("created", created);
        ("actor_nonce", member "actor_nonce" next_ack) ] in
    expect "new cannot nominate a nonce" (member "ok" denied <> `Bool true);
    Unix.close supplied;
    let previous, reply = v2_resume fixture created ack in
    expect "clean actor remains resumable before its slot retires"
      (member "input_ack_v2" reply = ack
       && member "input_ack" (v2_input previous 1 "a") = `Bool true);
    Unix.close previous;
    ignore (wait_until "previous v2 actor detached" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    let malformed, denied = v2_attachment fixture
      [ ("mode", `String "new"); ("created", created);
        ("slot", `Int 0) ] in
    expect "new cannot nominate a slot"
      (member "ok" denied <> `Bool true);
    Unix.close malformed;
    let malformed, denied = v2_attachment fixture
      [ ("mode", `String "resume"); ("created", created);
        ("slot", member "slot" next_ack);
        ("generation", `Int (-1));
        ("actor_nonce", member "actor_nonce" next_ack) ] in
    expect "malformed generation rejected"
      (member "ok" denied <> `Bool true);
    Unix.close malformed;
    let duplicate, denied = v2_attachment fixture
      [ ("mode", `String "new"); ("mode", `String "new");
        ("created", created) ] in
    expect "duplicate v2 keys rejected rather than last-wins"
      (member "ok" denied <> `Bool true);
    Unix.close duplicate;
    let resumed, reply = v2_resume fixture created next_ack in
    expect "correct nonce binds the same inactive slot and generation"
      (member "input_ack_v2" reply = next_ack
       && member "input_ack" (v2_input resumed 1 "b") = `Bool true);
    Unix.close resumed)

let acknowledged_v2_capacity () =
  with_host (fun fixture ->
    let created = member "created" (new_agent fixture) in
    let legacy_id = "retained-v1-actor-0123456789abcdef" in
    let legacy = ack_attachment fixture created legacy_id in
    ignore (next_frame legacy);
    ignore (next_frame legacy);
    expect "v1 input admitted"
      (member "input_ack" (v2_input legacy 1 "v1") = `Bool true);
    write_frame legacy 'H' (Yojson.Basic.to_string (`Assoc
      [ ("client_id", `String legacy_id); ("dirty", `Bool false) ]));
    close_attachment legacy;
    ignore (wait_until "v1 actor detached" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    let lost, reply = v2_new fixture created in
    let lost_actor = member "input_ack_v2" reply in
    expect "report-only actor accepted before lost ACK"
      (member "input_ack" (v2_input lost 1 "\x1b[I") = `Bool true);
    close_attachment lost;
    ignore (wait_until "clean report-only actor detached" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    let retried, reply = v2_resume fixture created lost_actor in
    expect "lost ACK recoverable before eligible clean actor retires"
      (member "input_ack_v2" reply = lost_actor
       && member "input_ack" (v2_input retried 1 "\x1b[I") = `Bool true);
    close_attachment retried;
    ignore (wait_until "report-only actor detached again" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    for index = 1 to 70 do
      let socket, reply = v2_new fixture created in
      expect "successive clean actors are admitted"
        (member "input_ack_v2" reply <> `Null);
      let actor = member "input_ack_v2" reply in
      if index <= 63 then
        expect "unused slots precede clean actor retirement"
          (member "slot" actor = `Int index);
      expect "each actor has accepted input"
        (member "input_ack" (v2_input socket 1 "x") = `Bool true);
      write_frame socket 'H' (Yojson.Basic.to_string (`Assoc
        [ ("slot", member "slot" actor);
          ("generation", member "generation" actor);
          ("dirty", `Bool false) ]));
      close_attachment socket;
      ignore (wait_until "v2 actor detached" 3. (fun () ->
        member "attached" (the_session fixture) = `Int 0))
    done;
    let retired, denied = v2_resume fixture created lost_actor in
    expect "retired clean actor cannot resume after bounded slot reuse"
      (member "ok" denied <> `Bool true);
    Unix.close retired;
    let legacy = ack_attachment fixture created legacy_id in
    expect "v1 history retained through v2 slot turnover"
      (contains (snd (next_frame legacy)) "acknowledged_input_v1");
    ignore (next_frame legacy);
    expect "v1 replayable bytes still ACK"
      (member "input_ack" (v2_input legacy 1 "v1") = `Bool true);
    close_attachment legacy;
    ignore (wait_until "v1 actor detached again" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    let active = ref [] in
    for index = 1 to 64 do
      let socket, reply = v2_new fixture created in
      expect
        (Printf.sprintf "active actor %d admitted: %s" index
          (Yojson.Basic.to_string reply))
        (member "input_ack_v2" reply <> `Null);
      active := socket :: !active
    done;
    let extra, denied = v2_new fixture created in
    expect "65th active actor refused" (member "ok" denied <> `Bool true);
    Unix.close extra;
    List.iter Unix.close !active;
    ignore (wait_until "all actors detached" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    let dirty = ref [] in
    for _ = 1 to 64 do
      let socket, reply = v2_new fixture created in
      let actor = member "input_ack_v2" reply in
      write_frame socket 'H' (Yojson.Basic.to_string (`Assoc
        [ ("slot", member "slot" actor);
          ("generation", member "generation" actor);
          ("dirty", `Bool true) ]));
      dirty := socket :: !dirty
    done;
    List.iter Unix.close !dirty;
    ignore (wait_until "dirty actors detached" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    let extra, denied = v2_new fixture created in
    expect "65th dirty actor refused" (member "ok" denied <> `Bool true);
    Unix.close extra)

let acknowledged_v2_epochs () =
  with_host (fun fixture ->
    let created = member "created" (new_agent fixture) in
    let old, response = v2_new fixture created in
    let actor = member "input_ack_v2" response in
    let marker = Filename.concat fixture.home "unadmitted-marker" in
    expect "old actor assigned" (actor <> `Null);
    let stopped = stop_agent fixture created in
    let fresh = member "created" stopped in
    expect "incarnation changed" (fresh <> created);
    expect "old input refused without reaching new agent"
      (member "reason" (v2_input old 1 "old-input")
       = `String "stale_incarnation");
    write_frame old 'H' (Yojson.Basic.to_string (`Assoc
      [ ("slot", member "slot" actor);
        ("generation", member "generation" actor); ("dirty", `Bool true) ]));
    let stale, denied = v2_resume fixture fresh actor in
    expect "old generation cannot resume on replacement"
      (member "ok" denied <> `Bool true);
    Unix.close stale;
    Unix.close old;
    ignore (wait_until "old epoch detached" 3. (fun () ->
      member "attached" (the_session fixture) = `Int 0));
    let current, current_reply = v2_new fixture fresh in
    expect "new epoch admits fresh actor"
      (member "input_ack_v2" current_reply <> `Null);
    ignore (wait_until "stale lease control did not dirty replacement" 3.
      (fun () -> member "ok"
        (switch_fence fixture "switch_input_acquire" fresh fence_id)
        = `Bool true));
    expect "new input refused while fenced"
      (member "reason" (v2_input current 1
        ("echo unadmitted > " ^ Filename.quote marker ^ "\r"))
       = `String "switch_input_fenced");
    expect "new input can be admitted after release"
      (member "ok"
        (switch_fence fixture "switch_input_release" fresh fence_id)
       = `Bool true);
    Unix.sleepf 0.2;
    expect "refused bytes caused no PTY command output"
      (not (Sys.file_exists marker));
    expect "refused input did not consume sequence"
      (member "input_ack" (v2_input current 1 "admitted") = `Bool true);
    Unix.close current)

let acknowledged_reports () =
  with_host (fun fixture ->
      let created = member "created" (new_agent fixture) in
      let id = "reports-actor-0123456789abcdef" in
      let socket = ack_attachment fixture created id in
      expect "report attachment negotiated"
        (contains (snd (next_frame socket)) "acknowledged_input_v1");
      ignore (next_frame socket);
      let frame seq data =
        let head = Bytes.create 4 in
        Bytes.set_int32_be head 0 (Int32.of_int seq);
        write_frame socket 'I' (Bytes.to_string head ^ data);
        Yojson.Basic.from_string (next_input_ack socket)
      in
      let accepted seq data =
        expect "report or human bytes ACKed"
          (member "input_ack" (frame seq data) = `Bool true)
      in
      accepted 1 "\x1b[I";
      accepted 1 "\x1b[I";
      expect "same sequence with changed classification cannot be ACKed"
        (member "reason" (frame 1 "human") = `String "sequence_conflict");
      ignore (wait_until "focus-only report leaves fence acquirable" 3. (fun () ->
        member "ok" (switch_fence fixture "switch_input_acquire" created fence_id)
        = `Bool true));
      expect "report still refused while fenced"
        (member "reason" (frame 2 "\x1b[O")
         = `String "switch_input_fenced");
      expect "release after focus" (member "ok"
        (switch_fence fixture "switch_input_release" created fence_id)
        = `Bool true);
      let fence_id = "switch-mouse-0123456789abcdef" in
      List.iteri (fun i report -> accepted (i + 2) report)
        [ "\x1b[<0;5;5M"; "\x1b[<32;6;7M"; "\x1b[<0;6;7m";
          "\x1b[7;9R"; "\x1b[0n" ];
      ignore (wait_until "SGR and terminal replies leave fence acquirable" 3.
        (fun () -> member "ok"
          (switch_fence fixture "switch_input_acquire" created fence_id)
          = `Bool true));
      expect "release after mouse" (member "ok"
        (switch_fence fixture "switch_input_release" created fence_id)
        = `Bool true);
      let fence_id = "switch-human-0123456789abcdef" in
      accepted 7 "human-draft";
      accepted 8 "\x1b[O";
      expect "focus report never clears a human draft"
        (member "reason" (switch_fence fixture "switch_input_acquire" created fence_id)
         = `String "input_pending");
      write_frame socket 'H' (Yojson.Basic.to_string (`Assoc
        [ ("client_id", `String id); ("dirty", `Bool false) ]));
      ignore (wait_until "explicit human completion releases dirty lease" 3.
        (fun () -> member "ok"
          (switch_fence fixture "switch_input_acquire" created fence_id)
          = `Bool true));
      expect "release after human completion" (member "ok"
        (switch_fence fixture "switch_input_release" created fence_id)
        = `Bool true);
      let fence_id = "switch-mixed-0123456789abcdef" in
      accepted 9 "\x1b[I\r";
      expect "mixed focus and CR is human input"
        (member "reason" (switch_fence fixture "switch_input_acquire" created fence_id)
         = `String "input_pending");
      Unix.close socket)

let v1_capacity_across_incarnations () =
  with_host (fun fixture ->
    let created = member "created" (new_agent fixture) in
    let id n = Printf.sprintf "v1-actor-%016d" n in
    let open_actor n created =
      let socket = ack_attachment fixture created (id n) in
      let _, greeting = next_frame socket in
      socket, greeting
    in
    let accept_input socket =
      ignore (next_frame socket);
      let head = Bytes.create 4 in
      Bytes.set_int32_be head 0 1l;
      write_frame socket 'I' (Bytes.to_string head ^ "\x1b[O");
      expect "positive receipt" (contains (next_input_ack socket) {|"input_ack":true|})
    in
    for n = 0 to 62 do
      let socket, greeting = open_actor n created in
      expect "actor attached" (contains greeting "acknowledged_input_v1");
      accept_input socket;
      Unix.close socket
    done;
    let reserved, greeting = open_actor 63 created in
    expect "last slot reserved before input" (contains greeting "acknowledged_input_v1");
    ignore (next_frame reserved);
    let refused, greeting = open_actor 64 created in
    expect "reservation prevents a 65th actor" (not (contains greeting "acknowledged_input_v1"));
    Unix.close refused;
    Unix.close reserved;
    ignore (wait_until "unused reservation released" 3. (fun () ->
      let candidate, greeting = open_actor 64 created in
      if contains greeting "acknowledged_input_v1" then (
        accept_input candidate; Unix.close candidate; true)
      else (Unix.close candidate; false)));
    ignore (wait_until "all actors detached" 3. (fun () -> member "attached" (the_session fixture) = `Int 0));
    let stopped = stop_agent fixture created in
    expect "agent stopped" (member "ok" stopped = `Bool true);
    let next = member "created" stopped in
    let fresh, greeting = open_actor 65 next in
    expect "fresh incarnation has capacity" (contains greeting "acknowledged_input_v1");
    Unix.close fresh;
    let stale, greeting = open_actor 66 created in
    expect "old incarnation still refused" (not (contains greeting "acknowledged_input_v1"));
    Unix.close stale)

let acknowledged_input () =
  with_host (fun fixture ->
      let created = member "created" (new_agent fixture) in
      let id = "actor-0123456789abcdef" in
      let socket = ack_attachment fixture created id in
      let _, greeting = next_frame socket in
      expect "native capability"
        (contains greeting "acknowledged_input_v1");
      ignore (next_frame socket);
      let frame seq data =
        let head = Bytes.create 4 in
        Bytes.set_int32_be head 0 (Int32.of_int seq);
        write_frame socket 'I' (Bytes.to_string head ^ data)
      in
      frame 1 "a";
      let ack = next_input_ack socket in
      expect "native ACK after enqueue" (contains ack {|input_ack|});
      frame 1 "a";
      let duplicate = next_input_ack socket in
      expect "duplicate ACK" (contains duplicate {|input_ack|});
      frame 1 "changed";
      let refusal = next_input_ack socket in
      expect "sequence reuse rejected" (contains refusal {|sequence_conflict|});
      frame 3 "out-of-order";
      expect "sequence gap rejected"
        (contains (next_input_ack socket) {|sequence_gap|});
      write_frame socket 'I' (String.make 4 '\000');
      expect "missing payload rejected"
        (contains (next_input_ack socket) {|invalid_frame|});
      let oversized = Bytes.create 4 in
      Bytes.set_int32_be oversized 0 2l;
      write_frame socket 'I' (Bytes.to_string oversized ^ String.make 65537 'x');
      expect "oversized input rejected without changing the sequence"
        (contains (next_input_ack socket) {|invalid_frame|});
      expect "dirty attachment refuses acquisition"
        (member "reason" (switch_fence fixture "switch_input_acquire" created fence_id)
         = `String "input_pending");
      Unix.close socket;
      ignore (wait_until "acknowledged attachment detached" 3. (fun () ->
        member "attached" (the_session fixture) = `Int 0));
      let reattached = ack_attachment fixture created id in
      expect "same-incarnation reconnect keeps capability"
        (contains (snd (next_frame reattached)) "acknowledged_input_v1");
      ignore (next_frame reattached);
      let head = Bytes.create 4 in
      Bytes.set_int32_be head 0 1l;
      write_frame reattached 'I' (Bytes.to_string head ^ "a");
      expect "ACK-lost retry is idempotent across connections"
        (Yojson.Basic.Util.member "input_ack"
          (Yojson.Basic.from_string (next_input_ack reattached)) = `Bool true);
      let second_id = "second-actor-0123456789abcdef" in
      let second = ack_attachment fixture created second_id in
      expect "second negotiated attachment"
        (contains (snd (next_frame second)) "acknowledged_input_v1");
      ignore (next_frame second);
      write_frame second 'I' (Bytes.to_string head ^ "b");
      expect "second actor accepted"
        (Yojson.Basic.Util.member "input_ack"
          (Yojson.Basic.from_string (next_input_ack second)) = `Bool true);
      write_frame reattached 'H'
        (Yojson.Basic.to_string (`Assoc [
          ("client_id", `String id); ("dirty", `Bool false) ]));
      expect "second dirty actor still defers fence"
        (member "reason" (switch_fence fixture "switch_input_acquire" created fence_id)
         = `String "input_pending");
      write_frame second 'H'
        (Yojson.Basic.to_string (`Assoc [
          ("client_id", `String second_id); ("dirty", `Bool false) ]));
       ignore (wait_until "acknowledged attachment acquisition" 3. (fun () ->
         member "ok" (switch_fence fixture "switch_input_acquire" created fence_id)
         = `Bool true));
       Unix.close second;
       Bytes.set_int32_be head 0 1l;
       write_frame reattached 'I' (Bytes.to_string head ^ "a");
       expect "exact previously accepted input can recover its ACK while fenced"
         (member "input_ack" (Yojson.Basic.from_string (next_input_ack reattached))
          = `Bool true);
       write_frame reattached 'I' (Bytes.to_string head ^ "changed");
       expect "changed retry remains refused while fenced"
         (contains (next_input_ack reattached) "switch_input_fenced");
       Bytes.set_int32_be head 0 2l;
      write_frame reattached 'I' (Bytes.to_string head ^ "fenced");
       expect "fenced input refused before enqueue"
         (contains (next_input_ack reattached) "switch_input_fenced");
       Unix.close reattached;
       ignore (wait_until "fenced v1 actor detached" 3. (fun () ->
         member "attached" (the_session fixture) = `Int 0));
       let reattached = ack_attachment fixture created id in
       expect "known v1 actor reconnects while fenced"
         (contains (snd (next_frame reattached)) "acknowledged_input_v1");
       ignore (next_frame reattached);
       Bytes.set_int32_be head 0 1l;
       write_frame reattached 'I' (Bytes.to_string head ^ "a");
       expect "v1 ACK-lost retry after reconnect while fenced"
         (member "input_ack" (Yojson.Basic.from_string (next_input_ack reattached))
          = `Bool true);
       Bytes.set_int32_be head 0 2l;
      type_in reattached "raw-after-negotiation";
      expect "raw input never bypasses negotiated fence"
        (contains (next_control reattached) "switch_input_fenced");
      expect "release succeeds"
        (member "ok" (switch_fence fixture "switch_input_release" created fence_id)
         = `Bool true);
      write_frame reattached 'I' (Bytes.to_string head ^ "fenced");
      expect "retry after release accepted"
        (Yojson.Basic.Util.member "input_ack"
          (Yojson.Basic.from_string (next_input_ack reattached)) = `Bool true);
      let stopped = stop_agent fixture created in
      let fresh = member "created" stopped in
      expect "native incarnation changed" (fresh <> created);
      write_frame reattached 'I' (Bytes.to_string head ^ "fenced");
      expect "old attachment cannot type into new incarnation"
        (contains (next_input_ack reattached) "stale_incarnation");
      let stale = ack_attachment fixture created "new-actor-0123456789abcdef" in
      let _, denied = next_frame stale in
      expect "old created cannot reattach" (not (contains denied "acknowledged_input_v1"));
      Unix.close stale;
      Unix.close reattached;
      ignore (wait_until "old actor detached" 3. (fun () ->
        member "attached" (the_session fixture) = `Int 0));
      let reused = ack_attachment fixture fresh id in
      let _, denied = next_frame reused in
      expect "an actor id with old history cannot impersonate a new incarnation"
        (not (contains denied "acknowledged_input_v1"));
      Unix.close reused)

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

let fenced_relaunch () =
  with_host (fun fixture ->
      let session = new_agent fixture in
      let old = member "created" session in
      let legacy = attach fixture in
      ignore (wait_until "legacy attach" 3. (fun () ->
        member "attached" (the_session fixture) = `Int 1));
      expect "legacy attachment prevents acquisition"
        (member "reason" (switch_fence fixture "switch_input_acquire" old fence_id)
         = `String "legacy_attachment");
      Unix.close legacy;
      ignore (wait_until "legacy detach" 3. (fun () ->
        member "attached" (the_session fixture) = `Int 0));
      let acquired = switch_fence fixture "switch_input_acquire" old fence_id in
      expect ("acquire: " ^ Yojson.Basic.to_string acquired)
        (member "ok" acquired = `Bool true);
      expect "idempotent acquire"
        (member "ok" (switch_fence fixture "switch_input_acquire" old fence_id)
         = `Bool true);
      expect "another owner refused"
        (member "ok" (switch_fence fixture "switch_input_acquire" old "other-owner-0123456789abcdef")
         = `Bool false);
      expect "stale acquire refused"
        (member "ok" (switch_fence fixture "switch_input_acquire" (`Float 1.) fence_id)
         = `Bool false);
      expect "another host receipt cannot release"
        (member "ok"
           (send fixture
              [ ("op", `String "switch_input_release");
                ("name", `String "relaunch"); ("created", old);
                ("creation_receipt",
                 `String (String.make 64 '0' ^ ":0000000000000001"));
                ("fence_id", `String fence_id) ])
         = `Bool false);
      let desk = attach fixture in
      let refused_bytes = ref "" in
      ignore (wait_until "legacy attachment refused" 3. (fun () ->
        refused_bytes := !refused_bytes ^ received desk;
        contains !refused_bytes "invalid request"));
      expect "new legacy attachment refused while fenced"
        (member "attached" (the_session fixture) = `Int 0);
      Unix.close desk;
      let notice =
        send fixture
          [ ("op", `String "notify_if"); ("name", `String "relaunch");
            ("created", old); ("agent", `String "claude");
            ("notification_id", `String "notice-0123456789abcdef");
            ("count", `Int 1); ("idle_since", `Float (Unix.gettimeofday () +. 1.));
            ("through_seq", `Int 1) ]
      in
      expect "wake refused while fenced"
        (member "reason" notice = `String "switch_input_fenced");
      expect "wrong release refused"
        (member "ok" (switch_fence fixture "switch_input_release" old "other-owner-0123456789abcdef")
         = `Bool false);
      expect "unowned stop refused"
        (member "ok" (stop_agent fixture old) = `Bool false);
      let stopped =
        send fixture [ ("op", `String "stop_agent_if"); ("name", `String "relaunch");
          ("created", old); ("agent", `String "claude");
          ("fence_id", `String fence_id) ]
      in
      expect "owned stop" (member "ok" stopped = `Bool true);
      let fresh = member "created" stopped in
      expect "old incarnation cannot release"
        (member "ok" (switch_fence fixture "switch_input_release" old fence_id)
         = `Bool false);
      expect "unowned start refused"
        (member "ok" (start_again fixture fresh) = `Bool false);
      expect "wrong-owner start refused"
        (member "ok"
           (start_again ~fence:"other-owner-0123456789abcdef" fixture fresh)
         = `Bool false);
      expect "owned start"
        (member "ok" (start_again ~fence:fence_id fixture fresh) = `Bool true);
      started fixture 2;
      expect "new agent started before release"
        (List.exists (fun line -> contains line "/accounts/b") (log_lines fixture));
      expect "even after control launch, wake is refused"
        (member "reason"
           (send fixture
             [ ("op", `String "notify_if"); ("name", `String "relaunch");
               ("created", fresh); ("agent", `String "claude");
               ("notification_id", `String "notice-new-0123456789abcdef");
               ("count", `Int 1); ("idle_since", `Float (Unix.gettimeofday () +. 1.));
               ("through_seq", `Int 2) ])
         = `String "switch_input_fenced");
      expect "fence remains held across transport disconnect"
        (member "ok" (switch_fence fixture "switch_input_acquire" fresh "other-owner-0123456789abcdef")
         = `Bool false);
      expect "explicit release"
        (member "ok" (switch_fence fixture "switch_input_release" fresh fence_id)
         = `Bool true);
      expect "retirement survives the changed agent incarnation"
        (member "reason" (switch_fence fixture "switch_input_acquire" fresh fence_id)
         = `String "fence_retired");
      let after = attach fixture in
      let replay = ref "" in
      let new_pid = List.nth (agent_pids fixture) 1 in
      ignore (wait_until "agent output retained while fenced" 3. (fun () ->
        replay := !replay ^ received after;
        contains !replay (Printf.sprintf "agent-start %d /accounts/b" new_pid)));
      Unix.close after;
      expect "no early release left" (List.length (agent_pids fixture) = 2))

let retired_fence_races () =
  with_host (fun fixture ->
      let created = member "created" (new_agent fixture) in
      let receipt = match send fixture [("op", `String "list_bound")] with
        | `List [session] -> member "creation_receipt" session
        | _ -> failwith "bound listing" in
      let fields op id = [ ("op", `String op); ("name", `String "relaunch");
        ("created", created); ("creation_receipt", receipt); ("fence_id", `String id) ] in
      let payload = Yojson.Basic.to_string (`Assoc (fields "switch_input_acquire" fence_id)) in
      let delayed = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
      Fun.protect ~finally:(fun () -> Unix.close delayed) (fun () ->
          Unix.setsockopt_float delayed Unix.SO_RCVTIMEO 5.;
          Unix.connect delayed (Unix.ADDR_UNIX fixture.socket_path);
          let header = Bytes.create 5 in
          Bytes.set header 0 'C'; Bytes.set_int32_be header 1 (Int32.of_int (String.length payload));
          expect "delayed connection header" (Unix.write delayed header 0 5 = 5);
          expect "release before delayed acquire" (member "ok" (send fixture (fields "switch_input_release" fence_id)) = `Bool true);
          expect "duplicate release" (member "ok" (send fixture (fields "switch_input_release" fence_id)) = `Bool true);
          expect "finish delayed acquire" (Unix.write_substring delayed payload 0 (String.length payload) = String.length payload);
          let size = Bytes.get_int32_be (read_exactly delayed 5) 1 |> Int32.to_int in
          let late = Yojson.Basic.from_string (Bytes.to_string (read_exactly delayed size)) in
          expect "delayed acquire rejected" (member "reason" late = `String "fence_retired"));
      let owner = "other-owner-0123456789abcdef" in
      expect "different owner acquires" (member "ok" (send fixture (fields "switch_input_acquire" owner)) = `Bool true);
      expect "retired owner cannot release new owner" (member "reason" (send fixture (fields "switch_input_release" fence_id)) = `String "fence_mismatch");
      expect "owner releases" (member "ok" (send fixture (fields "switch_input_release" owner)) = `Bool true);
      expect "owner release retry" (member "ok" (send fixture (fields "switch_input_release" owner)) = `Bool true);
      expect "released owner cannot acquire again" (member "reason" (send fixture (fields "switch_input_acquire" owner)) = `String "fence_retired");
      expect "stale incarnation refused" (member "reason" (send fixture (List.map (fun (k,v) -> if k = "created" then (k, `Float 1.) else (k,v)) (fields "switch_input_release" fence_id))) = `String "stale_incarnation");
      expect "stale receipt refused" (member "reason" (send fixture (List.map (fun (k,v) -> if k = "creation_receipt" then (k, `String (String.make 64 '0' ^ ":0000000000000001")) else (k,v)) (fields "switch_input_release" fence_id))) = `String "stale_incarnation"))

let retired_fence_capacity () =
  with_host (fun fixture ->
      let created = member "created" (new_agent fixture) in
      for n = 0 to 254 do
        expect "bounded retirement" (member "ok" (switch_fence fixture "switch_input_release" created (Printf.sprintf "retired-fence-%016d" n)) = `Bool true)
      done;
      let last = "last-owner-0123456789abcdef" in
      expect "last capacity reserved by acquire" (member "ok" (switch_fence fixture "switch_input_acquire" created last) = `Bool true);
      expect "other release cannot consume reserved slot" (member "reason" (switch_fence fixture "switch_input_release" created "retired-fence-9999999999999999") = `String "fence_mismatch");
      expect "reserved owner can retire" (member "ok" (switch_fence fixture "switch_input_release" created last) = `Bool true);
      expect "known retirement remains idempotent" (member "ok" (switch_fence fixture "switch_input_release" created "retired-fence-0000000000000000") = `Bool true);
      expect "new retirement fails closed at cap" (member "reason" (switch_fence fixture "switch_input_release" created "retired-fence-9999999999999999") = `String "fence_history_full");
      expect "new acquire fails closed at cap" (member "reason" (switch_fence fixture "switch_input_acquire" created "retired-fence-9999999999999999") = `String "fence_history_full");
      expect "old retirement still blocks acquire" (member "reason" (switch_fence fixture "switch_input_acquire" created "retired-fence-0000000000000000") = `String "fence_retired"))

let retired_fence_host_restart () =
  with_host (fun fixture ->
      let old_created = member "created" (new_agent fixture) in
      let old_receipt = match send fixture [("op", `String "list_bound")] with
        | `List [session] -> member "creation_receipt" session | _ -> failwith "old bound listing" in
      expect "old host release" (member "ok" (switch_fence fixture "switch_input_release" old_created fence_id) = `Bool true);
      fixture.restart_host ();
      let fresh = member "created" (new_agent fixture) in
      let stale = send fixture [ ("op", `String "switch_input_release"); ("name", `String "relaunch");
            ("created", fresh); ("creation_receipt", old_receipt); ("fence_id", `String fence_id) ] in
      expect "old host receipt cannot release on restarted host" (member "reason" stale = `String "stale_incarnation"))

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
          Alcotest.test_case "legacy mutations keep last-wins with v2 marker" `Slow
            legacy_duplicate_fields_with_v2_marker;
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
          Alcotest.test_case "switch input fence survives stop/start" `Slow
            fenced_relaunch;
          Alcotest.test_case "retired fences reject delayed acquire" `Slow retired_fence_races;
          Alcotest.test_case "retired fence capacity fails closed" `Slow retired_fence_capacity;
          Alcotest.test_case "old host receipt is stale" `Slow retired_fence_host_restart;
           Alcotest.test_case "acknowledged human input" `Slow
             acknowledged_input;
           Alcotest.test_case "v1 capacity and incarnation" `Slow
             v1_capacity_across_incarnations;
           Alcotest.test_case "versioned input actor generation" `Slow
             acknowledged_v2;
           Alcotest.test_case "versioned bounded actor reuse" `Slow
             acknowledged_v2_capacity;
           Alcotest.test_case "versioned actor epoch isolation" `Slow
             acknowledged_v2_epochs;
           Alcotest.test_case "versioned fenced resize isolation" `Slow
             acknowledged_v2_resize_fences;
           Alcotest.test_case "versioned stale resize isolation" `Slow
             acknowledged_v2_stale_resize;
           Alcotest.test_case "revoked dirty actor keeps disconnect grace" `Slow
             acknowledged_v2_revoked_dirty;
          Alcotest.test_case "acknowledged terminal reports do not own a draft" `Slow
            acknowledged_reports;
        ] );
    ]
