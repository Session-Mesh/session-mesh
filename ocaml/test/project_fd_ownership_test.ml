(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module O = Mesh_project_observation
module S = Mesh_project_store
module U = Yojson.Basic.Util
let s x = `String x
let uid n = Printf.sprintf "00000000-0000-4000-8000-%012d" n
let value r k = U.to_string (U.member k r)
let write p text = let c=open_out p in output_string c text; close_out c
let run ?(success=false) ?(spawn_failure=false) count =
  let root=Filename.temp_dir ~temp_dir:(Test_scratch.short_temp_root ()) "fd-probe-" "" in
  let entry=Filename.concat root "collector.mjs" and sentinel=Filename.concat root "sentinel" in
  write sentinel "retained ownership\n";
  let validator = match Sys.getenv_opt "MESH_PROJECT_VALIDATOR_ENTRY" with
    | Some path -> Unix.realpath path
    | None -> Unix.realpath "tools/project-observation.mjs" in
  let result = if success then "{state:'complete',catalog:{kind:'mesh-project-catalog',schema_version:2,features:['project-metadata/1','roster-followup/1'],machine_id:i.scope.machine_id,revision:'a'.repeat(64),generated_at:'2026-11-15T00:00:00Z',projects:[{id:i.scope.project_id,title:'Fixture',sources:[],sessions:[]}]}}"
    else "{state:'failed',code:'collector-invalid'}" in
  write entry ("import {main as validatorMain} from " ^ Printf.sprintf "%S" validator ^ ";if(process.argv[2]==='--validate-catalog'){await validatorMain(['--validate-catalog']);}else{let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{const i=JSON.parse(raw);process.stdout.write(JSON.stringify({kind:'mesh-project-observation-output',version:1,observation_id:i.observation_id,boot:i.boot,scope:i.scope,result:" ^ result ^ ",settlement:{providers_closed:true,provider_pipes_closed:true}}));});}\n");
  let reserve () = List.init 6 (fun _ -> Unix.openfile sentinel [Unix.O_RDONLY;Unix.O_CLOEXEC] 0) in
  let expected_free = if spawn_failure then reserve () else [] in
  List.iter Unix.close expected_free;
  let runtime = if spawn_failure then (
    let path=Filename.concat root "invalid-runtime" in
    write path "#!/nonexistent-mesh-test-interpreter\n"; Unix.chmod path 0o700; path)
    else Test_scratch.node () in
  Unix.putenv "MESH_PROJECT_OBSERVATION_RUNTIME" runtime;
  Unix.putenv "MESH_PROJECT_OBSERVATION_ENTRY" entry;
  let boot=String.make 64 'b' in
  let store=S.make ~root ~boot ~machine:(fun () -> "host") () in
  let saved=S.run store ~isolated:false ["op",s "project_create";"version",`Int 1;"boot",s boot;"expected_revision",s "cfg1_missing";"request_id",s(uid 1);"project",`Assoc ["title",s "Project";"observation",`Assoc ["repository",`Bool false;"source_ids",`List []]]] in
  if value saved "status" <> "ok" then failwith "SETUP: seed rejected";
  let lock=Mutex.create () and ready=Condition.create () and settled=ref false and drained=ref 0 and fds=ref [] in
  let hook = function
    | O.Pipes_drained ->
        incr drained;
        if !drained > (if success then 2 else 1) then failwith "SETUP: unexpected collector";
        fds := !fds @ List.init count (fun _ -> Unix.openfile sentinel [Unix.O_RDONLY;Unix.O_CLOEXEC] 0)
    | O.Settled -> Mutex.lock lock; settled:=true; Condition.signal ready; Mutex.unlock lock
    | _ -> () in
  let manager=O.make ~hook ~boot ~store () in
  Mutex.lock lock;
  let reply=O.run manager ~isolated:false ~stopping:false ["op",s "project_observation_start";"version",`Int 1;"boot",s boot;"machine_id",s "host";"project_id",s(uid 1);"expected_revision",U.member "revision" saved;"request_id",s(uid 2)] in
  if value reply "status" <> "ok" then failwith "SETUP: start rejected";
  while not !settled do Condition.wait ready lock done;
  Mutex.unlock lock;
  if !drained <> (if spawn_failure then 0 else if success then 2 else 1) then failwith "SETUP: collector did not drain";
  let bad=List.filter_map (fun (index,fd) -> try ignore(Unix.fstat fd); None with Unix.Unix_error(Unix.EBADF,_,_) -> Some index) (List.mapi (fun i fd -> i,fd) !fds) in
  let status=O.run manager ~isolated:false ~stopping:false ["op",s "project_observation_status";"version",`Int 1;"boot",s boot;"machine_id",s "host";"project_id",s(uid 1);"requested_revision",U.member "revision" saved;"request_id",s(uid 2);"observation_id",U.member "observation_id" reply] in
  Printf.printf "setup=ok drained=%d settled=true state=%s code=%s sentinels=%d invalid_sentinel_indices=[%s]\n%!" !drained (value status "observation_state") (match U.member "code" status with `String code -> code | _ -> "none") count (String.concat "," (List.map string_of_int bad));
  List.iter (fun fd -> try Unix.close fd with Unix.Unix_error(Unix.EBADF,_,_) -> ()) !fds;
  Alcotest.(check string) "actual collector result" (if success then "complete" else "failed") (value status "observation_state");
  if spawn_failure then (
    Alcotest.(check string) "actual create_process failure" "runtime-unavailable" (value status "code");
    let after=reserve () in
    let same=expected_free=after in
    List.iter Unix.close after;
    Alcotest.(check bool) "all six pipe descriptors released after spawn failure" true same
  );
  Ptyhost_blackbox.remove_tree root;
  Alcotest.(check (list int)) "collector must not close borrowed sentinel descriptors" [] bad
let () = Alcotest.run "collector descriptor ownership" ["ownership", [
  Alcotest.test_case "control without recycled descriptors" `Quick (fun () -> run 0);
  Alcotest.test_case "failed collector preserves recycled descriptors" `Quick (fun () -> run 12);
  Alcotest.test_case "successful collector and validator preserve recycled descriptors" `Quick (fun () -> run ~success:true 12);
  Alcotest.test_case "spawn failure releases all six pipe descriptors" `Quick (fun () -> run ~spawn_failure:true 0)]]
