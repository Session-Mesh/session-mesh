(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The attach reply of a PTY host, given as the first argument (words
   separated by spaces, so that [python3 ptyhost.py] can serve as the
   comparator), names the geometry the PTY had before the attach applied the
   attaching client's: the replay that follows was last produced at that
   geometry, and a browser interprets it there before taking its own size. *)

open Ptyhost_blackbox

let host_argv = ref [||]
let member key json = Yojson.Basic.Util.member key json

let with_host f =
  let scratch =
    Filename.temp_dir ~temp_dir:(Test_scratch.short_temp_root ()) "pty-geom-" ""
  in
  let home = Filename.concat scratch "home" in
  let runtime = Filename.concat scratch "run" in
  let shell = Filename.concat scratch "session-program.sh" in
  let socket_path = Filename.concat runtime "session-mesh/ptyhost.sock" in
  Unix.mkdir home 0o700;
  Unix.mkdir runtime 0o700;
  write_shell shell "#!/bin/sh\nexec sleep 600\n";
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
      f ~home socket_path)

(* Attach with [geometry] (none: the PTY keeps its size), return the reply
   and keep the attachment open until [f] returns. *)
let attached socket_path ?geometry name f =
  let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close socket)
    (fun () ->
      Unix.setsockopt_float socket Unix.SO_RCVTIMEO 5.;
      Unix.connect socket (Unix.ADDR_UNIX socket_path);
      let size =
        match geometry with
        | None -> []
        | Some (rows, cols) -> [ ("rows", `Int rows); ("cols", `Int cols) ]
      in
      let payload =
        Yojson.Basic.to_string
          (`Assoc ([ ("op", `String "attach"); ("name", `String name) ] @ size))
      in
      let head = Bytes.create 5 in
      Bytes.set head 0 'C';
      Bytes.set_int32_be head 1 (Int32.of_int (String.length payload));
      let message = Bytes.to_string head ^ payload in
      expect "attach written whole"
        (Unix.write_substring socket message 0 (String.length message)
        = String.length message);
      let reply_head = read_exactly socket 5 in
      expect "a control reply first" (Bytes.get reply_head 0 = 'C');
      let reply =
        read_exactly socket (Int32.to_int (Bytes.get_int32_be reply_head 1))
        |> Bytes.to_string |> Yojson.Basic.from_string
      in
      expect "attached" (member "ok" reply = `Bool true);
      f reply)

let replay_geometry reply =
  match member "replay_geometry" reply with
  | `Assoc _ as geometry ->
      Some
        ( Yojson.Basic.Util.to_int (member "rows" geometry),
          Yojson.Basic.Util.to_int (member "cols" geometry) )
  | _ -> None

let check label expected reply =
  Alcotest.(check (option (pair int int)))
    label expected (replay_geometry reply)

let geometry_before_the_attach () =
  with_host (fun ~home socket_path ->
      let created =
        request socket_path
          (Yojson.Basic.to_string
             (`Assoc
                [
                  ("op", `String "new");
                  ("name", `String "geom");
                  ("cwd", `String home);
                ]))
      in
      expect "session created" (member "ok" created = `Bool true);
      attached socket_path ~geometry:(30, 100) "geom" (fun reply ->
          check "the birth geometry" (Some (50, 200)) reply;
          attached socket_path ~geometry:(20, 60) "geom" (fun reply ->
              check "the first client's geometry" (Some (30, 100)) reply));
      attached socket_path "geom" (fun reply ->
          check "the last geometry applied" (Some (20, 60)) reply;
          attached socket_path "geom" (fun reply ->
              check "an attach without geometry kept it" (Some (20, 60)) reply)))

let () =
  let argv = Sys.argv in
  if Array.length argv < 2 then
    invalid_arg
      "usage: ptyhost_replay_geometry_test 'HOST [ARGS]' [alcotest options]";
  host_argv :=
    Array.of_list (List.filter (( <> ) "") (String.split_on_char ' ' argv.(1)));
  Alcotest.run
    ~argv:
      (Array.append [| argv.(0) |] (Array.sub argv 2 (Array.length argv - 2)))
    "PTY host replay geometry"
    [
      ( "attach",
        [
          Alcotest.test_case "the reply names the geometry before the attach"
            `Quick geometry_before_the_attach;
        ] );
    ]
