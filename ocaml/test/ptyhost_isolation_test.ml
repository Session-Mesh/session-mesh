(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Internal checks on the exact host source: a failure inside one session's
   fibers ends that session only, and a session's environment carries the
   runtime directory variables. *)

module Host = Ptyhost_isolation_impl

(* Fail the clock only after the victim's output has reached its replay.
   With no observer or attached clients, the output fiber feeds that replay
   and reads the clock without yielding. *)
let armed : (unit -> bool) option ref = ref None
let fault_injected = ref false

module Faulty_clock = struct
  type t = float Eio.Time.clock_ty Eio.Resource.t
  type time = float

  let now base =
    match !armed with
    | Some ready when ready () ->
        armed := None;
        fault_injected := true;
        failwith "injected clock failure"
    | _ -> Eio.Time.now base

  let sleep_until base time = Eio.Time.sleep_until base time
end

let faulty_clock_handler = Eio.Time.Pi.clock (module Faulty_clock)

let new_request name =
  [ ("op", `String "new"); ("name", `String name); ("cwd", `String "/") ]

let a_failing_session_ends_alone () =
  Eio_main.run @@ fun env ->
  let clock : float Eio.Time.clock_ty Eio.Resource.t =
    Eio.Resource.T (Eio.Stdenv.clock env, faulty_clock_handler)
  in
  let host_env =
    object
      method clock = clock
      method mono_clock = Eio.Stdenv.mono_clock env
      method process_mgr = Eio.Stdenv.process_mgr env
      method fs = Eio.Stdenv.fs env
      method secure_random = Eio.Stdenv.secure_random env
    end
  in
  let mono = Eio.Stdenv.mono_clock env in
  Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds mono 20.) @@ fun () ->
  Eio.Switch.run @@ fun sw ->
  let sessions = ref [] and owned = ref [] in
  let dispatch =
    Host.dispatch host_env sw sessions owned (Hashtbl.create 2) (ref [])
      (ref false) None
  in
  let find name =
    List.find (fun (s : Host.session) -> s.name = name) !sessions
  in
  ignore (dispatch (new_request "victim"));
  ignore (dispatch (new_request "survivor"));
  let victim = find "victim" and survivor = find "survivor" in
  Fun.protect
    ~finally:(fun () ->
      armed := None;
      List.iter (fun (s : Host.session) -> Host.signal s Sys.sigkill) !owned)
    (fun () ->
      let marker = "mesh-victim-output-marker" in
      fault_injected := false;
      armed := Some (fun () ->
          Ptyhost_blackbox.contains
            (Mesh_pty_support.Mesh_pty_replay.snapshot victim.replay) marker);
      ignore
        (Mesh_pty_support.Mesh_pty_input.enqueue victim.input
           ("echo " ^ marker ^ "\r"));
      Eio.Promise.await victim.done_;
      Alcotest.(check bool) "the victim received the injected fault" true
        !fault_injected;
      Alcotest.(check bool)
        "the failed session left the listing" false
        (List.memq victim !sessions);
      Alcotest.(check bool)
        "the failed session is no longer owned" false (List.memq victim !owned);
      Alcotest.(check bool)
        "the other session is still listed" true
        (List.memq survivor !sessions);
      ignore
        (Mesh_pty_support.Mesh_pty_input.enqueue survivor.input
           "echo survivor-still-here\r");
      let rec wait_output tries =
        if
          tries > 0
          && not
               (Ptyhost_blackbox.contains
                  (Mesh_pty_support.Mesh_pty_replay.snapshot survivor.replay)
                  "survivor-still-here\r\n")
        then (
          Eio.Time.Mono.sleep mono 0.1;
          wait_output (tries - 1))
      in
      wait_output 50;
      Alcotest.(check bool)
        "the other session still runs" true
        (Ptyhost_blackbox.contains
           (Mesh_pty_support.Mesh_pty_replay.snapshot survivor.replay)
           "survivor-still-here\r\n");
      Alcotest.(check bool)
        "the host still creates sessions" true
        (Yojson.Basic.Util.member "ok" (dispatch (new_request "after"))
        = `Bool true))

let env_value key environment =
  let prefix = key ^ "=" in
  Array.to_list environment
  |> List.filter (String.starts_with ~prefix)
  |> List.map (fun entry ->
      String.sub entry (String.length prefix)
        (String.length entry - String.length prefix))

(* Tools inside a session (mesh-attach, mesh-rename) find the host's socket
   through the same variables as the host, so the session keeps
   [MESH_RUNTIME_DIR]. A request's value replaces the inherited one: one entry
   per key. *)
let runtime_variable_reaches_the_session () =
  let previous = Sys.getenv_opt "MESH_RUNTIME_DIR" in
  Fun.protect
    ~finally:(fun () ->
      (* An empty value counts as unset. *)
      Unix.putenv "MESH_RUNTIME_DIR" (Option.value previous ~default:""))
    (fun () ->
      Unix.putenv "MESH_RUNTIME_DIR" "/inherited/run";
      Alcotest.(check (list string))
        "inherited" [ "/inherited/run" ]
        (env_value "MESH_RUNTIME_DIR" (Host.environment []));
      Alcotest.(check (list string))
        "the request's value replaces it" [ "/requested/run" ]
        (env_value "MESH_RUNTIME_DIR"
           (Host.environment
              [
                ( "env",
                  `Assoc [ ("MESH_RUNTIME_DIR", `String "/requested/run") ] );
              ])))

(* After the UID drop the runner's runtime directory is not the agent's, for
   [MESH_RUNTIME_DIR] as for [XDG_RUNTIME_DIR]. *)
let isolated_agent_drops_runtime_variables () =
  let agent =
    {
      Host.uid = 4242;
      gid = 4242;
      home = "/var/empty/agent";
      name = "agent";
      shell = "/bin/sh";
    }
  in
  let environment =
    Host.isolated_environment agent
      [|
        "MESH_RUNTIME_DIR=/run/runner";
        "XDG_RUNTIME_DIR=/run/runner";
        "MESH_SESSION=kept";
      |]
  in
  Alcotest.(check (list string))
    "MESH_RUNTIME_DIR dropped" []
    (env_value "MESH_RUNTIME_DIR" environment);
  Alcotest.(check (list string))
    "XDG_RUNTIME_DIR dropped" []
    (env_value "XDG_RUNTIME_DIR" environment);
  Alcotest.(check (list string))
    "other MESH_ keys kept" [ "kept" ]
    (env_value "MESH_SESSION" environment)

(* [probe_socket] on a socket file whose listener is gone, with the platform
   answering as given. *)
let stale_file_probe ~listening lookup =
  let dir = Filename.temp_dir "pty-probe-" "" in
  let path = Filename.concat dir "s" in
  let server = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  let closed = ref false in
  let close_server () =
    if not !closed then (
      closed := true;
      Unix.close server)
  in
  Fun.protect
    ~finally:(fun () ->
      close_server ();
      (try Sys.remove path with Sys_error _ -> ());
      Unix.rmdir dir)
    (fun () ->
      Unix.bind server (Unix.ADDR_UNIX path);
      Unix.listen server 1;
      if not listening then close_server ();
      Host.probe_socket ~lookup path)

let state_name = function
  | Host.Answering -> "answering"
  | Host.Bound -> "bound"
  | Host.Stale -> "stale"

let check_state what expected actual =
  Alcotest.(check string) what (state_name expected) (state_name actual)

(* With no platform inspection (macOS today) a refused connection alone marks
   the socket stale; an answering one is never touched. *)
let unsupported_platform_trusts_the_refusal () =
  let unsupported = Mesh_platform.For_testing.unsupported_unix_socket_bound in
  check_state "refused is stale" Host.Stale
    (stale_file_probe ~listening:false unsupported);
  check_state "answering stays answering" Host.Answering
    (stale_file_probe ~listening:true unsupported)

let readable_platform_keeps_a_bound_socket () =
  check_state "bound" Host.Bound
    (stale_file_probe ~listening:false (fun _ -> Ok true));
  check_state "unbound" Host.Stale
    (stale_file_probe ~listening:false (fun _ -> Ok false));
  check_state "unreadable table counts as bound" Host.Bound
    (stale_file_probe ~listening:false (fun _ -> Error Mesh_platform.Denied))

let () =
  Alcotest.run "PTY host isolation"
    [
      ( "isolation",
        [
          Alcotest.test_case "a failing session ends alone" `Quick
            a_failing_session_ends_alone;
          Alcotest.test_case "MESH_RUNTIME_DIR reaches the session" `Quick
            runtime_variable_reaches_the_session;
          Alcotest.test_case "an isolated agent gets no runtime variable" `Quick
            isolated_agent_drops_runtime_variables;
          Alcotest.test_case
            "unsupported inspection trusts a refused connection" `Quick
            unsupported_platform_trusts_the_refusal;
          Alcotest.test_case "a bound or unreadable answer keeps the socket"
            `Quick readable_platform_keeps_a_bound_socket;
        ] );
    ]
