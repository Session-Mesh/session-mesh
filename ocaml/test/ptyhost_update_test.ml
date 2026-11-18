(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The update check inside the built PTY host, over its socket only. The host
   is copied to releases/v0.1.0/bin/ (a release install: the version is the
   directory it runs from) and a fake curl stands in for the network: no
   request leaves the machine. What is checked: the answer reaches the
   [update_notice] request and the log once, a request that hangs neither
   blocks the host nor survives it, and a source install answers [null]. *)

open Ptyhost_blackbox

let list_body =
  {|[{"tag_name":"v0.2.0","draft":false,"prerelease":false,"body":"Security: yes"}]|}

let answering_curl =
  "#!/bin/sh\n\
   while [ $# -gt 0 ]; do\n\
   case \"$1\" in -D) h=$2; shift;; -o) o=$2; shift;; esac\n\
   shift\n\
   done\n\
   printf 'HTTP/2 200\\r\\netag: \"w1\"\\r\\n\\r\\n' > \"$h\"\n\
   printf '%s' '" ^ list_body ^ "' > \"$o\"\n\
   printf 200\n"

let hanging_curl scratch =
  "#!/bin/sh\necho $$ > '"
  ^ Filename.concat scratch "curl.pid"
  ^ "'\nexec sleep 600\n"

let copy source destination =
  let contents = In_channel.with_open_bin source In_channel.input_all in
  Out_channel.with_open_bin destination (fun channel ->
      output_string channel contents);
  Unix.chmod destination 0o755

let mkdir_p path =
  List.fold_left
    (fun parent name ->
      let directory = Filename.concat parent name in
      (try Unix.mkdir directory 0o700
       with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
      directory)
    "/"
    (String.split_on_char '/' path |> List.filter (( <> ) ""))
  |> ignore

let read_file path = In_channel.with_open_bin path In_channel.input_all

type fixture = {
  scratch : string;
  socket_path : string;
  log : string;
  host : string;
}

let with_fixture ~curl ~release f =
  let scratch =
    Filename.temp_dir ~temp_dir:(Test_scratch.short_temp_root ()) "pty-upd-" ""
  in
  Fun.protect
    ~finally:(fun () -> remove_tree scratch)
    (fun () ->
      let home = Filename.concat scratch "home"
      and runtime = Filename.concat scratch "run"
      and fakebin = Filename.concat scratch "fakebin" in
      List.iter (fun path -> mkdir_p path) [ home; runtime; fakebin ];
      write_shell (Filename.concat fakebin "curl") curl;
      let host_directory =
        if release then Filename.concat scratch "share/releases/v0.1.0/bin"
        else Filename.concat scratch "source"
      in
      mkdir_p host_directory;
      let host = Filename.concat host_directory "mesh-ptyhost" in
      copy Sys.argv.(1) host;
      f
        {
          scratch;
          socket_path = Filename.concat runtime "session-mesh/ptyhost.sock";
          log = Filename.concat scratch "host.log";
          host;
        })

let launch fixture =
  let environment =
    [|
      "PATH=" ^ Filename.concat fixture.scratch "fakebin" ^ ":/usr/bin:/bin";
      "LANG=C";
      "HOME=" ^ Filename.concat fixture.scratch "home";
      "XDG_RUNTIME_DIR=" ^ Filename.concat fixture.scratch "run";
      "MESH_CACHE_DIR=" ^ Filename.concat fixture.scratch "cache";
    |]
  in
  let null = Unix.openfile "/dev/null" [ Unix.O_RDWR ] 0 in
  let log =
    Unix.openfile fixture.log
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_APPEND ]
      0o600
  in
  let pid =
    Unix.create_process_env fixture.host [| fixture.host |] environment null
      null log
  in
  Unix.close null;
  Unix.close log;
  pid

let update_reply fixture = request fixture.socket_path {|{"op":"update_notice"}|}
let member key json = Yojson.Basic.Util.member key json

let test_answer_reaches_the_request () =
  with_fixture ~curl:answering_curl ~release:true (fun fixture ->
      let pid = launch fixture in
      Fun.protect
        ~finally:(fun () -> stop_host pid)
        (fun () ->
          wait_answering fixture.socket_path;
          ignore
            (wait_until "the answer" 10. (fun () ->
                 member "update" (update_reply fixture) <> `Null));
          let reply = update_reply fixture in
          expect "ok" (member "ok" reply = `Bool true);
          let update = member "update" reply in
          expect "available" (member "status" update = `String "available");
          expect "latest" (member "latest" update = `String "v0.2.0");
          expect "security" (member "security" update = `Bool true);
          expect "running" (member "current" update = `String "v0.1.0");
          let lines =
            String.split_on_char '\n' (read_file fixture.log)
            |> List.filter (fun line ->
                   String.starts_with
                     ~prefix:"mesh-ptyhost: Session Mesh v0.2.0 is available"
                     line)
          in
          expect "one log line" (List.length lines = 1);
          expect "the request takes no other field"
            (member "error"
               (request fixture.socket_path {|{"op":"update_notice","x":1}|})
            <> `Null);
          expect "sessions still listed"
            (match request fixture.socket_path {|{"op":"list"}|} with
            | `List [] -> true
            | _ -> false);
          expect "the cache was written"
            (Sys.file_exists (Filename.concat fixture.scratch "cache/update-check.json"))))

(* A request that never ends: the host serves meanwhile, and stopping it does
   not wait for the request, which is killed. *)
let test_hanging_request_never_blocks () =
  with_fixture
    ~curl:"" (* replaced below: the script needs the scratch path *)
    ~release:true
    (fun fixture ->
      write_shell
        (Filename.concat fixture.scratch "fakebin/curl")
        (hanging_curl fixture.scratch);
      let pid = launch fixture in
      let stopped = ref false in
      Fun.protect
        ~finally:(fun () -> if not !stopped then stop_host pid)
        (fun () ->
          wait_answering fixture.socket_path;
          let pid_file = Filename.concat fixture.scratch "curl.pid" in
          ignore (wait_until "curl started" 10. (fun () -> Sys.file_exists pid_file));
          let curl_pid = int_of_string (String.trim (read_file pid_file)) in
          let started = Unix.gettimeofday () in
          for _ = 1 to 20 do
            expect "no notice, no delay"
              (member "update" (update_reply fixture) = `Null)
          done;
          expect "the host answers while the request hangs"
            (Unix.gettimeofday () -. started < 2.);
          let stop_started = Unix.gettimeofday () in
          stop_host pid;
          stopped := true;
          expect "stopping does not wait for the request"
            (Unix.gettimeofday () -. stop_started < 4.);
          expect "the request was killed and reaped"
            (not (alive curl_pid))))

let test_source_install_has_nothing () =
  with_fixture ~curl:answering_curl ~release:false (fun fixture ->
      let pid = launch fixture in
      Fun.protect
        ~finally:(fun () -> stop_host pid)
        (fun () ->
          wait_answering fixture.socket_path;
          Unix.sleepf 0.5;
          expect "null"
            (update_reply fixture = `Assoc [ ("ok", `Bool true); ("update", `Null) ]);
          expect "no request, no file"
            (not (Sys.file_exists (Filename.concat fixture.scratch "cache")))))

(* The built host reads update-notice from the configuration directory
   (~/.config/session-mesh here): check=0 means no request and no answer, with
   no environment variable set. *)
let test_settings_file_turns_it_off () =
  with_fixture ~curl:answering_curl ~release:true (fun fixture ->
      let conf = Filename.concat fixture.scratch "home/.config/session-mesh" in
      mkdir_p conf;
      let file = Filename.concat conf "update-notice" in
      Out_channel.with_open_bin file (fun channel ->
          output_string channel "check=0\n");
      Unix.chmod file 0o600;
      let pid = launch fixture in
      Fun.protect
        ~finally:(fun () -> stop_host pid)
        (fun () ->
          wait_answering fixture.socket_path;
          Unix.sleepf 0.5;
          expect "null"
            (update_reply fixture = `Assoc [ ("ok", `Bool true); ("update", `Null) ]);
          expect "no request, no file"
            (not (Sys.file_exists (Filename.concat fixture.scratch "cache")))))

let () =
  if Array.length Sys.argv < 2 then
    invalid_arg "usage: ptyhost_update_test HOST_EXECUTABLE [alcotest options]";
  Alcotest.run
    ~argv:
      (Array.append [| Sys.argv.(0) |]
         (Array.sub Sys.argv 2 (Array.length Sys.argv - 2)))
    "PTY host update check"
    [
      ( "host",
        [
          Alcotest.test_case "the answer reaches update_notice and the log"
            `Quick test_answer_reaches_the_request;
          Alcotest.test_case "a hanging request never blocks the host" `Quick
            test_hanging_request_never_blocks;
          Alcotest.test_case "a source install has nothing" `Quick
            test_source_install_has_nothing;
          Alcotest.test_case "the settings file turns it off" `Quick
            test_settings_file_turns_it_off;
        ] );
    ]
