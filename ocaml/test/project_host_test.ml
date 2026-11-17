(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Ptyhost_blackbox
module U = Yojson.Basic.Util

let host = ref ""
and barrier_host = ref ""

let uid n = Printf.sprintf "00000000-0000-4000-8000-%012d" n
let str x = `String x
let check k e a = Alcotest.(check string) k e a
let value r k = U.to_string (U.member k r)

let call socket op fields =
  request socket
    (Yojson.Basic.to_string
       (`Assoc ([ ("op", str op); ("version", `Int 1) ] @ fields)))

type fixture = {
  root : string;
  conf : string;
  home : string;
  runtime : string;
  shell : string;
  socket : string;
  mutable pid : int;
  command : string;
  environment : string list;
}

let with_host ?(barrier = false) ?(extra_environment = []) f =
  let root =
    Filename.temp_dir
      ~temp_dir:(Test_scratch.short_temp_root ())
      "project-host-" ""
  in
  let path name = Filename.concat root name in
  List.iter (fun name -> Unix.mkdir (path name) 0o700) [ "home"; "run"; "conf" ];
  let shell = path "shell" in
  write_shell shell "#!/bin/sh\nexec /bin/cat\n";
  if barrier then Unix.mkfifo (path "release") 0o600;
  let command = if barrier then !barrier_host else !host in
  let environment =
    [ "MESH_CONF_DIR=" ^ path "conf" ]
    @ extra_environment
    @ if barrier then [ "PROJECT_TEST_BARRIER=" ^ root ] else []
  in
  let pid =
    start_host ~environment [| command |] ~home:(path "home")
      ~runtime:(path "run") ~shell
  in
  let x =
    {
      root;
      conf = path "conf";
      home = path "home";
      runtime = path "run";
      shell;
      socket = path "run/session-mesh/ptyhost.sock";
      pid;
      command;
      environment;
    }
  in
  Fun.protect
    ~finally:(fun () ->
      (* Even an early assertion must release the real protected workers before
         host shutdown; retain an RDWR FIFO endpoint until shutdown completes. *)
      let release =
        if barrier then (
          (try Unix.unlink (path "block-reads")
           with Unix.Unix_error (Unix.ENOENT, _, _) -> ());
          let fd =
            Unix.openfile (path "release") [ Unix.O_RDWR; Unix.O_NONBLOCK ] 0
          in
          ignore (Unix.write_substring fd "................" 0 16);
          Some fd)
        else None
      in
      Fun.protect
        ~finally:(fun () ->
          Option.iter Unix.close release;
          remove_tree root)
        (fun () -> stop_host x.pid))
    (fun () ->
      wait_answering x.socket;
      f x)

let restart f =
  stop_host f.pid;
  f.pid <-
    start_host ~environment:f.environment [| f.command |] ~home:f.home
      ~runtime:f.runtime ~shell:f.shell;
  wait_answering f.socket

let capability f = call f.socket "project_capabilities" []

let create f ?revision ?boot ?(title = "First") n =
  let boot =
    match boot with Some b -> b | None -> value (capability f) "boot"
  in
  let revision = Option.value ~default:"cfg1_missing" revision in
  call f.socket "project_create"
    [
      ("boot", str boot);
      ("expected_revision", str revision);
      ("request_id", str (uid n));
      ("project", `Assoc [ ("title", str title) ]);
    ]

let lifecycle () =
  with_host (fun f ->
      let cap = capability f in
      check "versioned capability" "mesh-project-reply" (value cap "kind");
      check "no sessions readiness" "unchecked" (value cap "store");
      let limits = U.member "limits" cap in
      List.iter
        (fun (key, expected) ->
          Alcotest.(check bool)
            ("actual socket capability " ^ key)
            true
            (U.member key limits = `Int expected))
        [
          ("max_folders", 100); ("max_sources", 20); ("max_source_changes", 40);
        ];
      let created = create f 1 in
      check "name-only create" "created" (value created "result");
      let revised =
        call f.socket "project_settings"
          [
            ("boot", U.member "boot" cap);
            ("expected_revision", U.member "revision" created);
            ("request_id", str (uid 2));
            ("project_id", str (uid 1));
            ( "patch",
              `Assoc
                [
                  ("title", str "Renamed");
                  ("folders", `List [ str "/one"; str "/two" ]);
                ] );
          ]
      in
      check "settings" "updated" (value revised "result");
      let machine = value created "machine_id" in
      let oldboot = value cap "boot" in
      restart f;
      let listed = call f.socket "project_list" [] in
      check "durable machine" machine (value listed "machine_id");
      Alcotest.(check bool) "new boot" true (oldboot <> value listed "boot");
      let stale = create f ~boot:oldboot 1 in
      check "stale boot" "stale-host" (value stale "code");
      let replay = create f 1 in
      check "lost original reply reconciles after rename/restart" "replayed"
        (value replay "result");
      let read = call f.socket "project_read" [ ("project_id", str (uid 1)) ] in
      let p = U.member "project" read in
      check "renamed durable" "Renamed" (value p "title");
      Alcotest.(check int)
        "folders durable" 2
        (U.to_int (U.member "folders_total" p));
      let second = create f ~revision:(value listed "revision") 3 in
      check "second client current revision" "created" (value second "result");
      let conflict = create f ~revision:(value listed "revision") 4 in
      check "stale client conflict" "revision-conflict" (value conflict "code"))

let strict_boundary () =
  with_host (fun f ->
      let before = request f.socket {|{"op":"list"}|} in
      Alcotest.(check bool) "zero sessions" true (before = `List []);
      List.iter
        (fun payload ->
          let r = request f.socket payload in
          check "strict mixed/duplicate op refused" "refused" (value r "status"))
        [
          Printf.sprintf
            {|{"op":"project_list","op":"new","name":"must-not-exist","cwd":%s}|}
            (Yojson.Basic.to_string (str f.home));
          Printf.sprintf
            {|{"op":"new","op":"project_list","name":"must-not-exist","cwd":%s}|}
            (Yojson.Basic.to_string (str f.home));
          {|{"op":"project_capabilities","op":"attach","name":"must-not-exist"}|};
          {|{"op":"project_capabilities","version":1,"version":1}|};
          {|{"op":"project_capabilities","version":1,"unknown":true}|};
        ];
      Alcotest.(check bool)
        "legacy new never executed" true
        (request f.socket {|{"op":"list"}|} = `List []);
      let unknown =
        request f.socket
          (Printf.sprintf
             {|{"op":"project_future","op":"new","name":"must-not-exist","cwd":%s}|}
             (Yojson.Basic.to_string (str f.home)))
      in
      Alcotest.(check bool)
        "unknown project duplicate also blocks legacy" true
        (U.member "error" unknown <> `Null
        && request f.socket {|{"op":"list"}|} = `List []);
      let oversize =
        request f.socket
          ("{" ^ String.make 131072 ' '
         ^ "\"op\":\"project_list\",\"version\":1}")
      in
      check "raw whitespace bytes count" "request-oversize"
        (value oversize "code");
      let bad =
        request f.socket
          {|{"op":"project_create","version":1,"boot":"wrong","expected_revision":"cfg1_missing","request_id":"00000000-0000-4000-8000-000000000001","project":{"title":"No"}}|}
      in
      check "boot before FS" "stale-host" (value bad "code");
      Alcotest.(check bool)
        "no registry side effect" false
        (Sys.file_exists (Filename.concat f.conf "projects.json"));
      (* Legacy duplicate resolution remains available when no project op appears. *)
      Alcotest.(check bool)
        "legacy last wins" true
        (request f.socket {|{"op":"new","op":"list"}|} = `List []);
      Unix.chmod f.conf 0o755;
      check "unsafe root local failure" "unavailable"
        (value (call f.socket "project_list" []) "status");
      Alcotest.(check bool)
        "legacy remains alive" true
        (request f.socket {|{"op":"list"}|} = `List []))

let identity_split_socket () =
  (* Existing account only. These requests never spawn a child or execute
     setpriv; they exercise the actual host startup/dispatcher/socket refusal. *)
  ignore (Unix.getpwuid 1);
  with_host ~extra_environment:[ "MESH_PTY_AGENT_UID=1" ] (fun f ->
      Unix.mkfifo (Filename.concat f.conf "projects.json") 0o600;
      List.iter
        (fun op ->
          let response = call f.socket op [] in
          check "identity split native envelope" "mesh-project-reply"
            (value response "kind");
          check "identity split refuses before FIFO store read" "unsupported"
            (value response "status");
          check "identity split code" "identity-split" (value response "code"))
        [ "project_capabilities"; "project_list"; "project_create" ];
      Alcotest.(check bool)
        "legacy sessions stays available" true
        (request f.socket {|{"op":"list"}|} = `List []);
      Alcotest.(check bool)
        "FIFO not repaired" true
        ((Unix.lstat (Filename.concat f.conf "projects.json")).Unix.st_kind
       = Unix.S_FIFO))

let frame kind payload =
  let b = Bytes.create 5 in
  Bytes.set b 0 kind;
  Bytes.set_int32_be b 1 (Int32.of_int (String.length payload));
  Bytes.to_string b ^ payload

let send fd kind text =
  let bytes = frame kind text in
  let rec write i =
    if i < String.length bytes then
      let n = Unix.write_substring fd bytes i (String.length bytes - i) in
      if n = 0 then failwith "socket closed" else write (i + n)
  in
  write 0

let recv fd =
  let h = read_exactly fd 5 in
  ( Bytes.get h 0,
    Bytes.to_string (read_exactly fd (Int32.to_int (Bytes.get_int32_be h 1))) )

let terminal_marker f marker =
  let fd = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      Unix.connect fd (Unix.ADDR_UNIX f.socket);
      Unix.setsockopt_float fd Unix.SO_RCVTIMEO 2.;
      send fd 'C' {|{"op":"attach","name":"terminal"}|};
      let kind, reply = recv fd in
      Alcotest.(check bool)
        "attached" true
        (kind = 'C'
        && U.member "ok" (Yojson.Basic.from_string reply) = `Bool true);
      ignore (recv fd);
      let started = Unix.gettimeofday () in
      send fd 'D' (marker ^ "\n");
      let output = Buffer.create 128 in
      let rec read () =
        let kind, data = recv fd in
        if kind = 'D' then Buffer.add_string output data;
        if not (contains (Buffer.contents output) marker) then read ()
      in
      read ();
      Alcotest.(check bool)
        "terminal marker under 2s while native FS blocked" true
        (Unix.gettimeofday () -. started < 2.))

let async ?(allow_timeout = false) f op fields =
  let output = Filename.temp_file ~temp_dir:f.root "reply-" ".json" in
  match Unix.fork () with
  | 0 -> (
      try
        let reply =
          try call f.socket op fields
          with
          | Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _)
          when allow_timeout
          ->
            `Assoc [ ("client_timeout", `Bool true) ]
        in
        let c = open_out output in
        output_string c (Yojson.Basic.to_string reply);
        close_out c;
        Unix._exit 0
      with _ -> Unix._exit 2)
  | pid -> (pid, output)

let join (pid, path) =
  let _, status = Unix.waitpid [] pid in
  Alcotest.(check bool) "worker client exits" true (status = Unix.WEXITED 0);
  Yojson.Basic.from_string (file_contents path)

let touch path =
  let fd = Unix.openfile path [ Unix.O_CREAT; Unix.O_WRONLY ] 0o600 in
  Unix.close fd

let competing_first_creates () =
  with_host (fun f ->
      let boot = U.member "boot" (capability f) in
      let one n =
        async f "project_create"
          [
            ("boot", boot);
            ("expected_revision", str "cfg1_missing");
            ("request_id", str (uid n));
            ("project", `Assoc [ ("title", str ("Project " ^ string_of_int n)) ]);
          ]
      in
      let a = one 1 and b = one 2 in
      let replies = List.map join [ a; b ] in
      Alcotest.(check (list string))
        "one publication, one stale conflict" [ "conflict"; "ok" ]
        (List.sort String.compare
           (List.map (fun r -> value r "status") replies));
      let listed = call f.socket "project_list" [] in
      Alcotest.(check int)
        "one persistent identity" 1
        (U.to_int (U.member "total" listed)))

let killed_writer_lock () =
  with_host ~barrier:true (fun f ->
      let boot = U.member "boot" (capability f) in
      let writer =
        async f "project_create"
          [
            ("boot", boot);
            ("expected_revision", str "cfg1_missing");
            ("request_id", str (uid 1));
            ("project", `Assoc [ ("title", str "Interrupted") ]);
          ]
      in
      ignore
        (wait_until "writer real temp synced before kill" 2. (fun () ->
             Sys.file_exists (Filename.concat f.root "blocked")));
      Unix.kill f.pid Sys.sigkill;
      ignore (Unix.waitpid [] f.pid);
      let client, _ = writer in
      let _, client_status = Unix.waitpid [] client in
      Alcotest.(check bool)
        "killed host loses reply" true
        (client_status = Unix.WEXITED 2);
      Alcotest.(check bool)
        "dead writer lock retained" true
        (Sys.file_exists (Filename.concat f.conf "projects.lock"));
      f.pid <-
        start_host ~environment:f.environment [| f.command |] ~home:f.home
          ~runtime:f.runtime ~shell:f.shell;
      ignore
        (wait_until "restarted killed writer host answering" 10. (fun () ->
             try answering f.socket
             with Unix.Unix_error (Unix.ECONNRESET, _, _) -> false));
      let response = create f 2 in
      check "restart never steals killed writer lock" "busy"
        (value response "status");
      check "status is pending not absent" "pending"
        (value
           (call f.socket "project_status"
              [ ("project_id", str (uid 1)); ("request_id", str (uid 1)) ])
           "intent_state");
      Alcotest.(check bool)
        "no repair publication" false
        (Sys.file_exists (Filename.concat f.conf "projects.json")))

let blocked_workers () =
  with_host ~barrier:true (fun f ->
      let cap = capability f in
      let spawned =
        request f.socket
          (Yojson.Basic.to_string
             (`Assoc
                [
                  ("op", str "new");
                  ("name", str "terminal");
                  ("cwd", str f.home);
                ]))
      in
      Alcotest.(check bool)
        "terminal started" true
        (U.member "ok" spawned = `Bool true);
      let writer =
        async ~allow_timeout:true f "project_create"
          [
            ("boot", U.member "boot" cap);
            ("expected_revision", str "cfg1_missing");
            ("request_id", str (uid 1));
            ("project", `Assoc [ ("title", str "Blocked") ]);
          ]
      in
      let count () =
        try String.length (file_contents (Filename.concat f.root "blocked"))
        with Sys_error _ -> 0
      in
      ignore (wait_until "writer after temp fsync" 2. (fun () -> count () = 1));
      let status =
        call f.socket "project_status"
          [ ("project_id", str (uid 1)); ("request_id", str (uid 1)) ]
      in
      check "actual in-flight pending" "pending" (value status "intent_state");
      terminal_marker f "blocked-before-timeout";
      (* Explicitly exceed the response budget: the real worker and lock remain. *)
      Unix.sleepf 5.1;
      check "writer still pending after 5s" "pending"
        (value
           (call f.socket "project_status"
              [ ("project_id", str (uid 1)); ("request_id", str (uid 1)) ])
           "intent_state");
      touch (Filename.concat f.root "block-reads");
      let readers = List.init 3 (fun _ -> async f "project_list" []) in
      ignore
        (wait_until "four actual blocked workers" 2. (fun () -> count () = 4));
      check "fifth no queue" "busy"
        (value (call f.socket "project_list" []) "status");
      let status_busy =
        call f.socket "project_status"
          [ ("project_id", str (uid 1)); ("request_id", str (uid 1)) ]
      in
      check "saturated status remains bounded busy" "busy"
        (value status_busy "status");
      check "busy includes captured project identity" (uid 1)
        (value status_busy "project_id");
      check "busy includes captured request identity" (uid 1)
        (value status_busy "request_id");
      terminal_marker f "blocked-after-timeout-reconnect";
      Unix.unlink (Filename.concat f.root "block-reads");
      let fd =
        Unix.openfile (Filename.concat f.root "release") [ Unix.O_WRONLY ] 0
      in
      ignore (Unix.write_substring fd "...." 0 4);
      Unix.close fd;
      let written = join writer in
      Alcotest.(check bool)
        "expired caller times out or receives deadline rejection" true
        (U.member "client_timeout" written = `Bool true
        || U.member "status" written = str "unavailable");
      List.iter (fun worker -> ignore (join worker)) readers;
      ignore
        (wait_until "actual writer finishes after caller timeout" 2. (fun () ->
             not (Sys.file_exists (Filename.concat f.conf "projects.lock"))));
      Alcotest.(check bool)
        "worker relinquishes lock only when finished" false
        (Sys.file_exists (Filename.concat f.conf "projects.lock"));
      Alcotest.(check bool)
        "deadline left config absent" false
        (Sys.file_exists (Filename.concat f.conf "projects.json"));
      terminal_marker f "after-worker-release")

let observation_fixture mode f =
  let root = Filename.temp_dir ~temp_dir:(Test_scratch.short_temp_root ()) "observation-fixture-" "" in
  Fun.protect ~finally:(fun () -> remove_tree root) (fun () ->
      let entry = Filename.concat root "collector.mjs" in
      let validator = match Sys.getenv_opt "MESH_PROJECT_VALIDATOR_ENTRY" with
        | Some path when Sys.file_exists path -> Unix.realpath path
        | _ when Sys.file_exists "tools/project-observation.mjs" -> Unix.realpath "tools/project-observation.mjs"
        | _ -> failwith "MESH_PROJECT_VALIDATOR_ENTRY must bind the actual built C validator" in
      let validation =
        if mode="validator-missing" then "process.exitCode=1;"
        else if mode="validator-malformed" then "process.stdout.write('{\"unexpected\":true}');"
        else if mode="validator-bad-digest" then
          "const write=process.stdout.write.bind(process.stdout);process.stdout.write=(chunk,...rest)=>{const ack=JSON.parse(String(chunk));ack.sha256='0'.repeat(64);return write(JSON.stringify(ack),...rest);};await validatorMain(['--validate-catalog']);"
        else if mode="validator-held" then
          "const iterator=process.stdin[Symbol.asyncIterator].bind(process.stdin);process.stdin[Symbol.asyncIterator]=async function*(){for await(const chunk of {[Symbol.asyncIterator]:iterator}){fs.writeFileSync(" ^ Printf.sprintf "%S" (Filename.concat root "validator-ready") ^ ",String(process.pid));while(!fs.existsSync(" ^ Printf.sprintf "%S" (Filename.concat root "validator-release") ^ "))await new Promise(resolve=>setTimeout(resolve,20));yield chunk;}};await validatorMain(['--validate-catalog']);"
        else "await validatorMain(['--validate-catalog']);" in
      write_shell entry
        ("import fs from 'node:fs';import {spawn} from 'node:child_process';import {main as validatorMain} from " ^ Printf.sprintf "%S" validator ^ ";if(process.argv[2]==='--validate-catalog'){" ^ validation ^ "}else{\nlet bytes='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>bytes+=b);process.stdin.on('end',()=>{const i=JSON.parse(bytes);fs.appendFileSync(" ^ Printf.sprintf "%S" (Filename.concat root "spawned") ^ ",i.observation_id+'\\n');\n" ^
         "const reply=(result)=>{process.stdout.write(JSON.stringify({kind:'mesh-project-observation-output',version:1,observation_id:i.observation_id,boot:i.boot,scope:i.scope,result,settlement:{providers_closed:true,provider_pipes_closed:true}}));};\n" ^
         (if mode="unverified" then "process.exit(17);"
          else if mode="held" then "const timer=setInterval(()=>{},1000);process.on('SIGTERM',()=>{clearInterval(timer);reply({state:'cancelled',code:'cancelled'});});fs.appendFileSync(" ^ Printf.sprintf "%S" (Filename.concat root "ready") ^ ",i.observation_id+'\\n');"
          else if mode="inherited-pipes" then "const child=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:['ignore','inherit','inherit']});child.unref();reply({state:'complete',catalog:{kind:'mesh-project-catalog',schema_version:2,features:['project-metadata/1','roster-followup/1'],machine_id:i.scope.machine_id,revision:'a'.repeat(64),generated_at:'2026-11-15T00:00:00Z',projects:[{id:i.scope.project_id,title:'Fixture',sources:[],sessions:[]}]}});process.stdout.write('',()=>process.exit(0));"
          else if mode="full" then
            let path = if Sys.file_exists "fixtures/projects/i1-catalog-2mib.json" then "fixtures/projects/i1-catalog-2mib.json" else "ocaml/test/fixtures/projects/i1-catalog-2mib.json" in
            "reply({state:'complete',catalog:JSON.parse(fs.readFileSync(" ^ Printf.sprintf "%S" (Unix.realpath path) ^ ",'utf8'))});"
          else "reply({state:'complete',catalog:{kind:'mesh-project-catalog',schema_version:2,features:['project-metadata/1','roster-followup/1'],machine_id:i.scope.machine_id,revision:'a'.repeat(64),generated_at:'2026-11-15T00:00:00Z',projects:[{id:i.scope.project_id,title:'Fixture',sources:[],sessions:[]}]}});") ^ "});}\n");
      f root ["MESH_PROJECT_OBSERVATION_RUNTIME=" ^ Test_scratch.node ();"MESH_PROJECT_OBSERVATION_ENTRY=" ^ entry])

let observation_seed f =
  touch (Filename.concat f.root "unblocked-writes");
  let created = create f 1 in
  let changed = call f.socket "project_settings"
      [("boot",U.member "boot" created);("expected_revision",U.member "revision" created);("request_id",str(uid 2));("project_id",str(uid 1));
       ("patch",`Assoc ["observation",`Assoc ["repository",`Bool false;"source_ids",`List []]])] in
  check "observation plan persisted" "ok" (value changed "status");
  changed

let observation_start f seed n =
  call f.socket "project_observation_start"
    ["boot",U.member "boot" seed;"machine_id",U.member "machine_id" seed;"project_id",U.member "project_id" seed;
     "expected_revision",U.member "revision" seed;"request_id",str(uid n)]
let observation_control f seed start op extras =
  call f.socket op
    (["boot",U.member "boot" seed;"machine_id",U.member "machine_id" seed;"project_id",U.member "project_id" seed;
      "requested_revision",U.member "revision" seed;"request_id",U.member "request_id" start;"observation_id",U.member "observation_id" start] @ extras)
let release f count =
  let fd=Unix.openfile (Filename.concat f.root "release") [Unix.O_WRONLY] 0 in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> ignore (Unix.write_substring fd (String.make count '.') 0 count))
(* Liveness bound, not a latency claim: a state is reached once Node workers have started and
   settled, which exceeded 4 s once on a 2-vCPU CI runner running the suite with -j2. The poll
   returns as soon as the state is reached. *)
let observation_liveness_s = 15.
let observation_wait f seed start expected =
  ignore (wait_until ("observation "^expected) observation_liveness_s (fun () ->
      value (observation_control f seed start "project_observation_status" []) "observation_state" = expected))

let observation_capture_lane () =
  observation_fixture "complete" (fun fixture env ->
      with_host ~barrier:true ~extra_environment:env (fun f ->
          let seed=observation_seed f in
          touch (Filename.concat f.root "block-capture");
          let a=observation_start f seed 11 and b=observation_start f seed 12 in
          ignore(wait_until "two actual capture barriers entered" 2. (fun () ->
              try List.length(List.filter((=)"capture") (String.split_on_char '\n' (file_contents(Filename.concat f.root "observation-events"))))=2 with Sys_error _ -> false));
          check "prompt capturing ack A" "capturing" (value a "observation_state");
          check "prompt capturing ack B" "capturing" (value b "observation_state");
          check "third capture bounded" "worker-capacity" (value (observation_start f seed 13) "code");
          check "held capture status" "capturing" (value (observation_control f seed a "project_observation_status" []) "observation_state");
          let replay=observation_start f seed 11 in
          check "retained capture handle" (value a "observation_id") (value replay "observation_id");
          check "independent registry list" "ok" (value (call f.socket "project_list" []) "status");
          let spawned=request f.socket (Yojson.Basic.to_string (`Assoc ["op",str "new";"name",str "terminal";"cwd",str f.home])) in
          Alcotest.(check bool) "terminal spawned" true (U.member "ok" spawned=`Bool true);
          terminal_marker f "observation-capture-held";
          let wrong=observation_control f seed a "project_observation_cancel" ["cancel_token",str(String.make 64 '0')] in
          check "wrong token no effect" "cancellation-denied" (value wrong "code");
          ignore (observation_control f seed a "project_observation_cancel" ["cancel_token",U.member "cancel_token" a]);
          let updated=call f.socket "project_settings" ["boot",U.member "boot" seed;"expected_revision",U.member "revision" seed;"request_id",str(uid 14);"project_id",str(uid 1);"patch",`Assoc ["title",str "New title"]] in
          check "registry mutation while two captures held" "ok" (value updated "status");
          Alcotest.(check bool) "no collector before capture release" false (Sys.file_exists (Filename.concat fixture "spawned"));
          Unix.unlink (Filename.concat f.root "block-capture"); release f 2;
          observation_wait f seed a "stale"; observation_wait f seed b "stale";
          Alcotest.(check bool) "late cancelled capture never spawns" false (Sys.file_exists (Filename.concat fixture "spawned"));
          terminal_marker f "observation-capture-settled"))

let observation_orderly_and_unverified () =
  observation_fixture "held" (fun fixture env ->
      with_host ~extra_environment:env (fun f ->
          let seed=observation_seed f in
          let a=observation_start f seed 21 and b=observation_start f seed 22 in
          ignore(wait_until "two actual collector children ready to cancel" 3. (fun () -> try List.length(String.split_on_char '\n' (file_contents(Filename.concat fixture "ready")))=3 with Sys_error _ -> false));
          check "third running bounded" "worker-capacity" (value(observation_start f seed 23) "code");
          check "running status" "running" (value(observation_control f seed a "project_observation_status" []) "observation_state");
          check "running page no data" "running" (value(observation_control f seed b "project_observation_page" ["page_index",`Int 0]) "observation_state");
          check "registry while held collectors" "ok" (value(call f.socket "project_list" []) "status");
          List.iter (fun r -> ignore(observation_control f seed r "project_observation_cancel" ["cancel_token",U.member "cancel_token" r])) [a;b];
          observation_wait f seed a "cancelled"; observation_wait f seed b "cancelled";
          let next=observation_start f seed 24 in
          check "verified cleanup releases slot" "ok" (value next "status");
          ignore(wait_until "replacement collector ready to cancel" 3. (fun () -> try List.length(String.split_on_char '\n' (file_contents(Filename.concat fixture "ready")))=4 with Sys_error _ -> false));
          ignore(observation_control f seed next "project_observation_cancel" ["cancel_token",U.member "cancel_token" next]);
          observation_wait f seed next "cancelled"));
  observation_fixture "unverified" (fun _ env ->
      with_host ~extra_environment:env (fun f ->
          let seed=observation_seed f in
          let a=observation_start f seed 31 and b=observation_start f seed 32 in
          observation_wait f seed a "cleanup-pending"; observation_wait f seed b "cleanup-pending";
          check "unverified exits remain charged" "worker-capacity" (value(observation_start f seed 33) "code");
          check "unverified state code" "worker-exited-unverified" (value(observation_control f seed a "project_observation_status" []) "code");
          check "registry survives unverified exit" "ok" (value(call f.socket "project_list" []) "status")))

let observation_controls_and_pages () =
  observation_fixture "complete" (fun _ env ->
      with_host ~barrier:true ~extra_environment:env (fun f ->
          let seed=observation_seed f in
          let a=observation_start f seed 41 in
          observation_wait f seed a "complete";
          let page=observation_control f seed a "project_observation_page" ["page_index",`Int 0] in
          let again=observation_control f seed a "project_observation_page" ["page_index",`Int 0] in
          check "immutable page bytes" (value page "data_base64") (value again "data_base64");
          Alcotest.(check bool) "status has no token" true (U.member "cancel_token" (observation_control f seed a "project_observation_status" [])=`Null);
          let terminal=observation_control f seed a "project_observation_cancel" ["cancel_token",U.member "cancel_token" a] in
          check "terminal cancel idempotent complete" "complete" (value terminal "observation_state");
          check "terminal cancel keeps bytes" (value page "data_base64") (value (observation_control f seed a "project_observation_page" ["page_index",`Int 0]) "data_base64");
          let fields=["boot",U.member "boot" seed;"machine_id",U.member "machine_id" seed;"project_id",str(uid 1);
            "requested_revision",U.member "revision" seed;"request_id",U.member "request_id" a;"observation_id",U.member "observation_id" a] in
          touch(Filename.concat f.root "block-control");
          let before=List.length(String.split_on_char '\n' (file_contents(Filename.concat f.root "observation-events"))) in
          let readers=List.init 4 (fun _ -> async f "project_observation_status" fields) in
          ignore(wait_until "four real bounded controls held" 2. (fun () ->
              let events=String.split_on_char '\n' (file_contents(Filename.concat f.root "observation-events")) in
              List.length events >= before+8));
          check "fifth control busy without queue" "control-capacity" (value(observation_control f seed a "project_observation_status" []) "code");
          check "registry independent of four controls" "ok" (value(call f.socket "project_list" []) "status");
          Unix.unlink(Filename.concat f.root "block-control"); release f 4;
          List.iter(fun reader -> check "held control resumes" "ok" (value(join reader) "status")) readers;
          check "control retry after release" "complete" (value(observation_control f seed a "project_observation_status" []) "observation_state");
          let raw=Yojson.Basic.to_string (`Assoc (("op",str "project_observation_status")::("version",`Int 1)::fields)) in
          let duplicate=String.sub raw 0 (String.length raw-1) ^ ",\"version\":1}" in
          check "native duplicate refused" "invalid-request" (value(request f.socket duplicate) "code");
          let unknown=call f.socket "project_observation_status" (("observation_id",str(String.make 64 'f'))::List.remove_assoc "observation_id" fields) in
          check "unknown explicit" "unknown" (value unknown "code");
          Alcotest.(check bool) "unknown has no lifetime state" true (U.member "observation_state" unknown=`Null);
          let wrong=call f.socket "project_observation_status" (("project_id",str "other")::List.remove_assoc "project_id" fields) in
          check "known scope mismatch" "lifetime-mismatch" (value wrong "code");
          let old=call f.socket "project_observation_status" (("boot",str(String.make 64 '0'))::List.remove_assoc "boot" fields) in
          check "old boot before lookup" "stale-host" (value old "code")))

let observation_full_catalog () =
  observation_fixture "full" (fun _ env ->
      with_host ~barrier:true ~extra_environment:env (fun f ->
          touch(Filename.concat f.root "unblocked-writes");
          let config=`Assoc ["kind",str "mesh-project-config";"schema_version",`Int 2;
            "features",`List [str "project-metadata/1";str "project-workspace/1";str "project-observation/1"];
            "machine_id",str "host";"projects",`List [`Assoc ["id",str "one";"title",str "One";"sources",`List [];"sessions",`List [];
              "observation",`Assoc ["repository",`Bool false;"source_ids",`List []]]]] in
          write_shell(Filename.concat f.conf "projects.json") (Yojson.Basic.to_string config);
          Unix.chmod(Filename.concat f.conf "projects.json") 0o600;
          let listed=call f.socket "project_list" [] in
          let seed=`Assoc ["boot",U.member "boot" listed;"machine_id",str "host";"project_id",str "one";"revision",U.member "revision" listed] in
          let a=observation_start f seed 51 in
          observation_wait f seed a "complete";
          let buffer=Buffer.create 2097152 in
          let descriptor=ref `Null in
          for index=0 to 15 do
            let reply=observation_control f seed a "project_observation_page" ["page_index",`Int index] in
            Alcotest.(check bool) "full page reply bounded" true (String.length(Yojson.Basic.to_string reply)<=196608);
            let raw=Base64.decode_exn(value reply "data_base64") in
            Alcotest.(check int) "canonical raw page" 131072 (String.length raw);
            Alcotest.(check int) "canonical index" index (U.to_int(U.member "page_index" reply));
            if index=0 then (descriptor:=U.member "descriptor" reply;Alcotest.(check int) "UTF8 scalar split first byte" 0xf0 (Char.code raw.[131071]));
            if index=1 then Alcotest.(check int) "UTF8 scalar split continuation" 0x9f (Char.code raw.[0]);
            Alcotest.(check bool) "immutable descriptor" true (!descriptor=U.member "descriptor" reply);
            Buffer.add_string buffer raw
          done;
          let raw=Buffer.contents buffer in
          Alcotest.(check int) "full 2MiB admitted" 2097152 (String.length raw);
          let digest=Digestif.SHA256.(to_hex(digest_string raw)) in
          check "immutable rich fixture digest" "26b47d85ca5fad370dbb1925f92bf952ec9a6214a8eab198dd7a9a5818f64995" digest;
          check "descriptor authentic exact bytes" digest (value !descriptor "sha256");
          Printf.printf "RECEIPT full_catalog_bytes=%d pages=16 sha256=%s split_utf8=131071\n%!" (String.length raw) digest;
          print_endline(file_contents(Filename.concat f.root "observation-events"));
          let update=call f.socket "project_settings" ["boot",U.member "boot" seed;"expected_revision",U.member "revision" seed;"request_id",str(uid 52);"project_id",str "one";"patch",`Assoc ["title",str "Changed"]] in
          check "update invalidates page lane" "ok" (value update "status");
          let stale=observation_control f seed a "project_observation_page" ["page_index",`Int 0] in
          check "known old snapshot stale" "stale" (value stale "observation_state");
          Alcotest.(check bool) "stale has no bytes" true (U.member "data_base64" stale=`Null)))

let observation_pipe_drain_and_runtime_race () =
  observation_fixture "inherited-pipes" (fun _ env ->
      with_host ~barrier:true ~extra_environment:env (fun f ->
          let seed=observation_seed f in
          let a=observation_start f seed 61 in
          ignore(wait_until "owned collector exited before inherited pipes" 2. (fun () ->
              try List.exists(fun line -> String.starts_with ~prefix:"child-exited:" line) (String.split_on_char '\n' (file_contents(Filename.concat f.root "observation-events"))) with Sys_error _ -> false));
          let pending=observation_control f seed a "project_observation_status" [] in
          check "witness and exit alone cannot settle before EOF" "cleanup-pending" (value pending "observation_state");
          Alcotest.(check bool) "no descriptor before real drain" true (U.member "descriptor" pending=`Null);
          observation_wait f seed a "complete";
          let events=file_contents(Filename.concat f.root "observation-events") in
          print_endline("RECEIPT inherited_pipes_actual_drain\n"^events)));
  observation_fixture "complete" (fun fixture env ->
      with_host ~barrier:true ~extra_environment:env (fun f ->
          let seed=observation_seed f in
          touch(Filename.concat f.root "block-capture");
          let a=observation_start f seed 71 in
          ignore(wait_until "runtime-race actual capture barrier entered" 2. (fun () ->
              try List.mem "capture" (String.split_on_char '\n' (file_contents(Filename.concat f.root "observation-events"))) with Sys_error _ -> false));
          Unix.unlink(Filename.concat fixture "collector.mjs");
          Unix.unlink(Filename.concat f.root "block-capture");release f 1;
          observation_wait f seed a "failed";
          check "admitted runtime race explicit failure" "runtime-unavailable" (value(observation_control f seed a "project_observation_status" []) "code");
          Alcotest.(check bool) "runtime disappearance never spawned" false (Sys.file_exists(Filename.concat fixture "spawned"));
          print_endline("RECEIPT runtime_disappearance_after_admission\n"^file_contents(Filename.concat f.root "observation-events"))))

let observation_borrowed_result_capacity () =
  observation_fixture "complete" (fun _ env ->
      with_host ~barrier:true ~extra_environment:env (fun f ->
          let seed=observation_seed f in
          let results=List.init 4(fun n -> let r=observation_start f seed (80+n) in observation_wait f seed r "complete";r) in
          touch(Filename.concat f.root "block-borrow");
          let fields r=["boot",U.member "boot" seed;"machine_id",U.member "machine_id" seed;"project_id",U.member "project_id" seed;
            "requested_revision",U.member "revision" seed;"request_id",U.member "request_id" r;"observation_id",U.member "observation_id" r;"page_index",`Int 0] in
          let readers=List.map(fun r -> async f "project_observation_page" (fields r)) results in
          ignore(wait_until "four retained results actually borrowed" 2. (fun () ->
              List.length(List.filter((=)"borrow") (String.split_on_char '\n' (file_contents(Filename.concat f.root "observation-events"))))=4));
          let fifth=observation_start f seed 84 in
          (* Controls are deliberately saturated; release readers before asking
             status, then check the already-finished publication outcome. *)
          ignore(wait_until "fifth worker settled without stealing borrowed result" 2. (fun () ->
              List.length(List.filter((=)"settled") (String.split_on_char '\n' (file_contents(Filename.concat f.root "observation-events"))))=5));
          Unix.unlink(Filename.concat f.root "block-borrow");release f 4;
          List.iter(fun reader -> Alcotest.(check bool) "borrowed result remains readable" true (U.member "data_base64" (join reader)<>`Null)) readers;
          check "borrowed publication refuses capacity" "result-capacity" (value(observation_control f seed fifth "project_observation_status" []) "code");
          let sixth=observation_start f seed 85 in observation_wait f seed sixth "complete";
          let first=List.hd results in
          let old=observation_control f seed first "project_observation_status" [] in
          check "oldest eligible result explicitly evicted" "expired" (value old "observation_state");
          check "eviction reason" "evicted" (value old "code");
          let replay=observation_start f seed 80 in
          check "evicted identity never recollects on replay" (value first "observation_id") (value replay "observation_id");
          check "replay retains evicted outcome" "expired" (value replay "observation_state");
          print_endline("RECEIPT borrowed_result_capacity\n"^file_contents(Filename.concat f.root "observation-events"))))

let observation_validator_faults () =
  List.iter (fun mode -> observation_fixture mode (fun _ env ->
      with_host ~extra_environment:env (fun f ->
          let seed=observation_seed f in
          let a=observation_start f seed 201 and b=observation_start f seed 202 in
          observation_wait f seed a "cleanup-pending";observation_wait f seed b "cleanup-pending";
          let status=observation_control f seed a "project_observation_status" [] in
          check "invalid validator ACK never completes" "worker-exited-unverified" (value status "code");
          Alcotest.(check bool) "invalid validator ACK no descriptor" true (U.member "descriptor" status=`Null);
          check "unverified validator ownership remains charged" "worker-capacity" (value(observation_start f seed 203) "code");
          check "registry independent from validator refusal" "ok" (value(call f.socket "project_list" []) "status"))))
    ["validator-missing";"validator-malformed";"validator-bad-digest"]
let observation_validator_cancel () =
  observation_fixture "validator-held" (fun fixture env ->
      with_host ~barrier:true ~extra_environment:env (fun f ->
          let seed=observation_seed f in
          let a=observation_start f seed 211 in
          ignore(wait_until "actual C validator waiting on retained input" observation_liveness_s (fun () -> Sys.file_exists(Filename.concat fixture "validator-ready")));
          check "validation remains within active lifetime" "running" (value(observation_control f seed a "project_observation_status" []) "observation_state");
          check "registry during held validator" "ok" (value(call f.socket "project_list" []) "status");
          let spawned=request f.socket (Yojson.Basic.to_string (`Assoc ["op",str "new";"name",str "terminal";"cwd",str f.home])) in
          Alcotest.(check bool) "PTY starts while validator held" true (U.member "ok" spawned=`Bool true);
          terminal_marker f "held-validator-independent";
          let cancelled=observation_control f seed a "project_observation_cancel" ["cancel_token",U.member "cancel_token" a] in
          Alcotest.(check bool) "cancel does not invent settlement" true (U.member "identity_retention_ms" cancelled=`Null);
          touch(Filename.concat fixture "validator-release");
          observation_wait f seed a "cancelled";
          let status=observation_control f seed a "project_observation_status" [] in
          Alcotest.(check bool) "cancelled validator cannot publish payload" true (U.member "descriptor" status=`Null);
          print_endline("RECEIPT actual C validator cancellation\n"^file_contents(Filename.concat f.root "observation-events"))))

let observation_discovery () =
  with_host (fun f ->
      let c = capability f in
      Alcotest.(check bool) "observation implemented" true
        (U.member "implemented" (U.member "observation" c) = `Bool true);
      let boot = value c "boot" in
      let r = call f.socket "project_observation_start"
        [("boot", str boot); ("machine_id", str "m"); ("project_id", str "p");
         ("expected_revision", str ("cfg1_" ^ String.make 64 'a')); ("request_id", str (uid 77))] in
      check "missing runtime leaves no handle" "runtime-not-configured" (value r "code"))

let () =
  if Array.length Sys.argv < 2 then
    invalid_arg "project_host_test HOST [PRIVATE_TEST_HOST]";
  host := Sys.argv.(1);
  barrier_host :=
    if Array.length Sys.argv > 2 then Sys.argv.(2)
    else
      Filename.concat (Filename.dirname !host) "../test/project_test_host.exe";
  let identity_tests =
    if
      Sys.file_exists "/proc/self"
      && Unix.geteuid () > 1
      && Unix.getegid () <> 1
    then
      [
        Alcotest.test_case "actual identity split socket refuses before store"
          `Quick identity_split_socket;
      ]
    else (
      prerr_endline
        "NOT RUN identity-split socket: requires Linux non-root account and \
         existing UID1; store refusal still covered";
      [])
  in
  Alcotest.run
    ~argv:
      (Array.append
         [| Sys.argv.(0) |]
         (let first = min 3 (Array.length Sys.argv) in
          Array.sub Sys.argv first (Array.length Sys.argv - first)))
    "native project host"
    [
      ( "socket",
        [
          Alcotest.test_case "held capture lane controls registry PTY" `Quick observation_capture_lane;
          Alcotest.test_case "real orderly and unverified collectors" `Quick observation_orderly_and_unverified;
          Alcotest.test_case "real four control lane and immutable pages" `Quick observation_controls_and_pages;
          Alcotest.test_case "exact 2MiB rich catalog canonical pages and stale" `Quick observation_full_catalog;
          Alcotest.test_case "actual inherited pipe drain and runtime race" `Quick observation_pipe_drain_and_runtime_race;
          Alcotest.test_case "borrowed result quotas eviction replay" `Quick observation_borrowed_result_capacity;
          Alcotest.test_case "validator missing malformed digest failures stay charged" `Quick observation_validator_faults;
          Alcotest.test_case "actual pure validator cancellation keeps lane independent" `Quick observation_validator_cancel;
          Alcotest.test_case "observation discovery and unavailable" `Quick observation_discovery;
          Alcotest.test_case "capability persistence restart CAS replay" `Quick
            lifecycle;
          Alcotest.test_case "strict op/raw limit and legacy isolation" `Quick
            strict_boundary;
          Alcotest.test_case "competing first creates serialize and conflict"
            `Quick competing_first_creates;
          Alcotest.test_case "killed native writer leaves bounded retained lock"
            `Quick killed_writer_lock;
          Alcotest.test_case
            "real blocked native workers preserve terminal reconnect" `Quick
            blocked_workers;
        ]
        @ identity_tests );
    ]
