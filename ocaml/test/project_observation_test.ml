(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module C=Mesh_project_codec
module S=Mesh_project_store
module O=Mesh_project_observation
module U=Yojson.Basic.Util
let s x = `String x
let uid n=Printf.sprintf "00000000-0000-4000-8000-%012d" n
let boot=String.make 64 'b'
let value reply key=U.to_string(U.member key reply)
let check=Alcotest.(check string)
let call t op fields=O.run t ~isolated:false ~stopping:false (("op",s op)::("version",`Int 1)::fields)
let fixture ?(capture=fun () -> ()) test =
  let root=Filename.temp_dir ~temp_dir:(Test_scratch.short_temp_root ()) "observation-unit-" "" in
  Fun.protect ~finally:(fun () -> Ptyhost_blackbox.remove_tree root) (fun () ->
      let entry=Filename.concat root "collector.mjs" in
      Ptyhost_blackbox.write_shell entry "process.exit(17);\n";
      let old_runtime=Sys.getenv_opt "MESH_PROJECT_OBSERVATION_RUNTIME" and old_entry=Sys.getenv_opt "MESH_PROJECT_OBSERVATION_ENTRY" in
      Unix.putenv "MESH_PROJECT_OBSERVATION_RUNTIME" (Test_scratch.node ());
      Unix.putenv "MESH_PROJECT_OBSERVATION_ENTRY" entry;
      Fun.protect ~finally:(fun () ->
          Unix.putenv "MESH_PROJECT_OBSERVATION_RUNTIME" (Option.value ~default:"" old_runtime);
          Unix.putenv "MESH_PROJECT_OBSERVATION_ENTRY" (Option.value ~default:"" old_entry)) (fun () ->
          let store=S.make ~root ~boot ~machine:(fun () -> "host") () in
          let saved=S.run store ~isolated:false ["op",s "project_create";"version",`Int 1;"boot",s boot;"expected_revision",s "cfg1_missing";"request_id",s(uid 1);"project",`Assoc ["title",s "Project";"observation",`Assoc ["repository",`Bool false;"source_ids",`List []]]] in
          check "seed" "ok" (value saved "status");
          let now=ref 100. and charges=ref [] and captures=ref 0 in
          let hook=function
            | O.Capture -> incr captures;capture ()
            | O.Charge(label,total) -> charges:=(label,total)::!charges
            | _ -> () in
          let manager=O.make ~hook ~now:(fun () -> !now) ~boot ~store () in
          test root entry manager now charges captures (value saved "revision")))
let start manager revision ?(project=uid 1) n = call manager "project_observation_start"
    ["boot",s boot;"machine_id",s "host";"project_id",s project;"expected_revision",s revision;"request_id",s(uid n)]
let control manager revision ?(project=uid 1) reply op extra=call manager op
    (["boot",s boot;"machine_id",s "host";"project_id",s project;"requested_revision",s revision;"request_id",U.member "request_id" reply;"observation_id",U.member "observation_id" reply]@extra)
let wait manager revision ?(project=uid 1) reply expected =
  ignore(Ptyhost_blackbox.wait_until expected 3. (fun () -> value(control manager revision ~project reply "project_observation_status" []) "observation_state"=expected))
let deadline_capture () =
  let read_fd,write_fd=Unix.pipe ~cloexec:true () in
  Fun.protect ~finally:(fun () -> Unix.close read_fd;Unix.close write_fd) (fun () ->
      fixture ~capture:(fun () -> let b=Bytes.create 1 in ignore(Unix.read read_fd b 0 1))
        (fun _ _ manager now charges captures revision ->
          let a=start manager revision 11 and b=start manager revision 12 in
          check "start ack capturing" "capturing" (value a "observation_state");
          ignore(Ptyhost_blackbox.wait_until "two actual capture threads held" 2. (fun () -> !captures=2));
          now:=131.;O.tick manager ~stopping:false;
          let status=control manager revision a "project_observation_status" [] in
          check "blocked capture deadline begins cleanup" "cleanup-pending" (value status "observation_state");
          check "deadline reason" "deadline" (value status "code");
          now:=1000.;O.tick manager ~stopping:false;
          check "active never expires" "worker-capacity" (value(start manager revision 13) "code");
          Alcotest.(check bool) "active no terminal-retention fiction" true (U.member "identity_retention_ms" status=`Null);
          ignore(Unix.write_substring write_fd ".." 0 2);
          wait manager revision a "cancelled";wait manager revision b "cancelled";
          Alcotest.(check bool) "charged ownership always within manager budget" true
            (List.for_all(fun(_,n)->n>=0 && n<=24*1024*1024) !charges);
          Alcotest.(check bool) "reserve and actual settlement release recorded" true
            (List.exists(fun(label,_)->label="worker-reserve-before-capture") !charges && List.exists(fun(label,_)->label="worker-release") !charges);
          let status=control manager revision a "project_observation_status" [] in
          Alcotest.(check bool) "terminal retention starts when capture returned" true (U.member "identity_retention_ms" status=`Int 120000);
          now:=1121.;O.tick manager ~stopping:false;
          check "terminal expires honestly unknown" "unknown" (value(control manager revision a "project_observation_status" []) "code")))
let record_capacity () =
  fixture(fun _ _ manager now charges _ revision ->
      let first=ref `Null in
      for n=1 to 128 do
        let reply=start manager revision ~project:"missing" (100+n) in
        if n=1 then first:=reply;
        check "bounded failed capture admitted" "ok" (value reply "status");
        wait manager revision ~project:"missing" reply "failed"
      done;
      check "finite identity capacity refuses before worker" "record-capacity" (value(start manager revision ~project:"missing" 999) "code");
      let replay=start manager revision ~project:"missing" 101 in
      check "retained failed identity replay" (value !first "observation_id") (value replay "observation_id");
      Alcotest.(check bool) "replay explicit" true (U.member "replayed" replay=`Bool true);
      check "changed replay tuple conflicts" "immutable-identity" (value(start manager revision ~project:"other" 101) "code");
      now:=221.;O.tick manager ~stopping:false;
      check "record aged out" "unknown" (value(control manager revision ~project:"missing" !first "project_observation_status" []) "code");
      let next=start manager revision ~project:"missing" 999 in
      check "expired records admit anew" "ok" (value next "status");
      wait manager revision ~project:"missing" next "failed";
      Printf.printf "RECEIPT terminal_record_quota=128 payload_budget_max=%d events=%d\n%!"
        (List.fold_left(fun m(_,n)->max m n) 0 !charges) (List.length !charges))
let completed_ttl () =
  fixture(fun _ entry manager now _ _ revision ->
      let validator = match Sys.getenv_opt "MESH_PROJECT_VALIDATOR_ENTRY" with
        | Some path when Sys.file_exists path -> Unix.realpath path
        | _ when Sys.file_exists "tools/project-observation.mjs" -> Unix.realpath "tools/project-observation.mjs"
        | _ -> failwith "MESH_PROJECT_VALIDATOR_ENTRY must bind actual built C validator" in
      Ptyhost_blackbox.write_shell entry
        ("import {main as validatorMain} from " ^ Printf.sprintf "%S" validator ^ ";if(process.argv[2]==='--validate-catalog'){await validatorMain(['--validate-catalog']);}else{let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const i=JSON.parse(raw);process.stdout.write(JSON.stringify({kind:'mesh-project-observation-output',version:1,boot:i.boot,observation_id:i.observation_id,scope:i.scope,settlement:{providers_closed:true,provider_pipes_closed:true},result:{state:'complete',catalog:{kind:'mesh-project-catalog',schema_version:2,features:['project-metadata/1','roster-followup/1'],machine_id:i.scope.machine_id,revision:'a'.repeat(64),generated_at:'2026-11-15T00:00:00Z',projects:[{id:i.scope.project_id,title:'Fixture',sources:[],sessions:[]}]}}}));});}\n");
      let a=start manager revision 500 in
      wait manager revision a "complete";
      now:=219.;
      let status=control manager revision a "project_observation_status" [] in
      Alcotest.(check bool) "publication TTL independent of reads" true (U.member "remaining_ms" status=`Int 1000);
      let replay=start manager revision 500 in
      check "same live result on replay" (value a "observation_id") (value replay "observation_id");
      now:=221.;O.tick manager ~stopping:false;
      check "read replay did not extend retention" "unknown" (value(control manager revision a "project_observation_status" []) "code");
      let next=start manager revision 500 in
      Alcotest.(check bool) "fully forgotten identity may admit a new explicit start" true (U.member "observation_id" next<>U.member "observation_id" a);
      wait manager revision next "complete")
let unverified_reason_is_sticky () =
  fixture(fun _ _ manager now _ _ revision ->
      let a=start manager revision 600 in
      wait manager revision a "cleanup-pending";
      (* The owned real child exits17 without a witness; no fake lifecycle flag. *)
      check "initial unverified reason" "worker-exited-unverified"
        (value(control manager revision a "project_observation_status" []) "code");
      now:=131.;O.tick manager ~stopping:false;
      let after_deadline=control manager revision a "project_observation_status" [] in
      check "deadline cannot hide unverified ownership" "worker-exited-unverified" (value after_deadline "code");
      let after_cancel=control manager revision a "project_observation_cancel" ["cancel_token",U.member "cancel_token" a] in
      check "cancel cannot hide unverified ownership" "worker-exited-unverified" (value after_cancel "code");
      check "unverified remains cleanup-pending" "cleanup-pending" (value after_cancel "observation_state");
      now:=1000.;O.tick manager ~stopping:false;
      let retained=control manager revision a "project_observation_status" [] in
      Alcotest.(check bool) "unverified cleanup never acquires terminal expiry" true (U.member "identity_retention_ms" retained=`Null);
      let b=start manager revision 601 in wait manager revision b "cleanup-pending";
      check "late unverified ownership retains both active charges" "worker-capacity" (value(start manager revision 602) "code"))
let ()=Alcotest.run "native observation ownership" ["ownership",[
    Alcotest.test_case "unverified reason survives deadline and cancellation" `Quick unverified_reason_is_sticky;
    Alcotest.test_case "completed monotonic TTL never extended by replay" `Quick completed_ttl;
    Alcotest.test_case "blocked real capture deadline accounting and retention" `Quick deadline_capture;
    Alcotest.test_case "128 finite records replay conflict and expiry" `Quick record_capacity]]
