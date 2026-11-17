(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Start-up of the built native host against its runtime directory:
   MESH_RUNTIME_DIR, else XDG_RUNTIME_DIR, validated before anything is
   created. A refusal is one "not starting" line and status 1. The host is the
   first argument. *)

open Ptyhost_blackbox

let host_argv = ref [||]

let with_scratch f =
  let scratch = Test_scratch.private_directory "pty-rundir-" in
  Fun.protect ~finally:(fun () -> remove_tree scratch) (fun () -> f scratch)

let private_subdirectory scratch name =
  let path = Filename.concat scratch name in
  Unix.mkdir path 0o700;
  Unix.chmod path 0o700;
  path

let socket_in runtime =
  Filename.concat runtime (Filename.concat "session-mesh" "ptyhost.sock")

(* Starts the host with [XDG_RUNTIME_DIR=xdg] plus [environment], and waits
   up to [timeout] seconds for it to exit. [None]: still running (then
   stopped). *)
let run_host ?(environment = []) ?(timeout = 10.) scratch ~xdg =
  let home = Filename.concat scratch "home" in
  if not (Sys.file_exists home) then Unix.mkdir home 0o700;
  let log_path = Filename.concat scratch "host.log" in
  let log =
    Unix.openfile log_path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_TRUNC ] 0o600
  in
  let started =
    Fun.protect
      ~finally:(fun () -> Unix.close log)
      (fun () ->
        host
          (start_host ~stderr:log ~environment !host_argv ~home ~runtime:xdg
             ~shell:"/bin/sh"))
  in
  let deadline = Unix.gettimeofday () +. timeout in
  while exited started = None && Unix.gettimeofday () < deadline do
    Unix.sleepf 0.02
  done;
  (started, log_path)

let expect_refusal ?environment scratch ~xdg ~reason =
  let started, log_path = run_host ?environment scratch ~xdg in
  let status = exited started in
  stop started;
  let log = file_contents log_path in
  expect
    (Printf.sprintf "exit status 1, log: %s" log)
    (status = Some (Unix.WEXITED 1));
  expect
    ("one not-starting line: " ^ log)
    (contains log "not starting: unusable runtime directory:");
  expect (Printf.sprintf "reason %S in: %s" reason log) (contains log reason);
  expect ("no exception: " ^ log)
    (not (contains log "exception" || contains log "Fatal error"));
  log

let relative_directory_is_refused () =
  with_scratch (fun scratch ->
      ignore
        (expect_refusal scratch ~xdg:"relative/run"
           ~reason:"XDG_RUNTIME_DIR: \"relative/run\" is not an absolute path"))

let group_writable_directory_is_refused () =
  with_scratch (fun scratch ->
      let runtime = private_subdirectory scratch "run" in
      Unix.chmod runtime 0o770;
      ignore
        (expect_refusal scratch ~xdg:runtime
           ~reason:"is writable by group or others");
      expect "nothing created inside"
        (not (Sys.file_exists (Filename.concat runtime "session-mesh"))))

(* A directory of another user: a canonical system directory owned by root. *)
let foreign_directory () =
  List.find_opt
    (fun path ->
      match Unix.lstat path with
      | { Unix.st_kind = Unix.S_DIR; st_uid; _ } ->
          st_uid <> Unix.geteuid () && Unix.realpath path = path
      | _ | (exception Unix.Unix_error _) -> false)
    [ "/usr"; "/etc"; "/var" ]

let foreign_owned_directory_is_refused () =
  match foreign_directory () with
  | None -> Alcotest.skip ()
  | Some foreign ->
      with_scratch (fun scratch ->
          ignore
            (expect_refusal scratch ~xdg:foreign
               ~reason:(Printf.sprintf "%S is owned by uid" foreign)))

(* A private directory whose socket path is over the sun_path limit. *)
let too_long_directory_is_refused () =
  with_scratch (fun scratch ->
      let suffix_length = String.length "/session-mesh/ptyhost.sock" in
      let name_length =
        max 1 (110 - String.length scratch - 1 - suffix_length)
      in
      let runtime =
        private_subdirectory scratch (String.make name_length 'r')
      in
      expect "the fixture is over the limit"
        (String.length (socket_in runtime) > 107);
      ignore (expect_refusal scratch ~xdg:runtime ~reason:"byte limit"))

let serves_on scratch ?environment ~xdg expected =
  let started, log_path = run_host ~timeout:0.3 ?environment scratch ~xdg in
  Fun.protect
    ~finally:(fun () -> stop started)
    (fun () ->
      expect ("the host runs: " ^ file_contents log_path) (exited started = None);
      wait_answering (socket_in expected))

let mesh_runtime_dir_wins () =
  with_scratch (fun scratch ->
      let xdg = private_subdirectory scratch "xdg"
      and mesh = private_subdirectory scratch "mesh" in
      serves_on scratch ~environment:[ "MESH_RUNTIME_DIR=" ^ mesh ] ~xdg mesh;
      expect "nothing under XDG_RUNTIME_DIR"
        (not (Sys.file_exists (Filename.concat xdg "session-mesh"))))

let invalid_mesh_runtime_dir_does_not_fall_through () =
  with_scratch (fun scratch ->
      let xdg = private_subdirectory scratch "xdg" in
      ignore
        (expect_refusal scratch
           ~environment:[ "MESH_RUNTIME_DIR=relative" ]
           ~xdg ~reason:"MESH_RUNTIME_DIR: \"relative\" is not an absolute path");
      expect "nothing under XDG_RUNTIME_DIR"
        (not (Sys.file_exists (Filename.concat xdg "session-mesh"))))

let empty_mesh_runtime_dir_counts_as_unset () =
  with_scratch (fun scratch ->
      let xdg = private_subdirectory scratch "xdg" in
      serves_on scratch ~environment:[ "MESH_RUNTIME_DIR=" ] ~xdg xdg)

let () =
  let argv = Sys.argv in
  if Array.length argv < 2 then
    invalid_arg "usage: ptyhost_runtime_dir_test HOST [alcotest options]";
  host_argv := [| argv.(1) |];
  Alcotest.run
    ~argv:
      (Array.append [| argv.(0) |] (Array.sub argv 2 (Array.length argv - 2)))
    "PTY host runtime directory"
    [
      ( "refusals",
        [
          Alcotest.test_case "a relative directory" `Quick
            relative_directory_is_refused;
          Alcotest.test_case "a group-writable directory" `Quick
            group_writable_directory_is_refused;
          Alcotest.test_case "a directory owned by another user" `Quick
            foreign_owned_directory_is_refused;
          Alcotest.test_case "a socket path over sun_path" `Quick
            too_long_directory_is_refused;
          Alcotest.test_case "an invalid MESH_RUNTIME_DIR does not fall through"
            `Quick invalid_mesh_runtime_dir_does_not_fall_through;
        ] );
      ( "precedence",
        [
          Alcotest.test_case "MESH_RUNTIME_DIR wins over XDG_RUNTIME_DIR" `Quick
            mesh_runtime_dir_wins;
          Alcotest.test_case "an empty MESH_RUNTIME_DIR counts as unset" `Quick
            empty_mesh_runtime_dir_counts_as_unset;
        ] );
    ]
