(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The size of a PTY that two clients show, through the host given as the
   first argument: the first attach with "size":"claim" sets it, a later one
   does not change it, a claim from a client that does not own it is ignored,
   an explicit take-over (and a resize without the field) moves it, a redraw
   (keep) leaves the owner, and the owner's departure frees it. Each claiming
   attachment receives an S frame {rows, cols, owner} at every change. *)

open Ptyhost_blackbox

let host_argv = ref [||]
let member key json = Yojson.Basic.Util.member key json

let with_host f =
  let scratch =
    Filename.temp_dir ~temp_dir:(Test_scratch.short_temp_root ()) "pty-size-" ""
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
      let created =
        request socket_path
          (Yojson.Basic.to_string
             (`Assoc
                [
                  ("op", `String "new");
                  ("name", `String "size");
                  ("cwd", `String home);
                ]))
      in
      expect "session created" (member "ok" created = `Bool true);
      f socket_path)

let write_frame socket kind payload =
  let head = Bytes.create 5 in
  Bytes.set head 0 kind;
  Bytes.set_int32_be head 1 (Int32.of_int (String.length payload));
  let message = Bytes.to_string head ^ payload in
  expect "frame written whole"
    (Unix.write_substring socket message 0 (String.length message)
    = String.length message)

let read_frame socket =
  let head = read_exactly socket 5 in
  let length = Int32.to_int (Bytes.get_int32_be head 1) in
  (Bytes.get head 0, Bytes.to_string (read_exactly socket length))

(* The next S frame, past terminal output, as "ROWSxCOLS owner". *)
let rec next_size socket =
  match read_frame socket with
  | 'S', payload ->
      let json = Yojson.Basic.from_string payload in
      Printf.sprintf "%dx%d %s"
        (Yojson.Basic.Util.to_int (member "rows" json))
        (Yojson.Basic.Util.to_int (member "cols" json))
        (Yojson.Basic.Util.to_string (member "owner" json))
  | _ -> next_size socket

(* No S frame arrives within [seconds]. *)
let no_size socket seconds =
  Unix.setsockopt_float socket Unix.SO_RCVTIMEO seconds;
  let rec drain () =
    match read_frame socket with
    | 'S', payload -> Some payload
    | _ -> drain ()
    | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EWOULDBLOCK), _, _) -> None
  in
  let result = drain () in
  Unix.setsockopt_float socket Unix.SO_RCVTIMEO 5.;
  Alcotest.(check (option string)) "no S frame" None result

let attach ?(fields = []) socket_path (rows, cols) =
  let socket = Unix.socket Unix.PF_UNIX Unix.SOCK_STREAM 0 in
  Unix.setsockopt_float socket Unix.SO_RCVTIMEO 5.;
  Unix.connect socket (Unix.ADDR_UNIX socket_path);
  write_frame socket 'C'
    (Yojson.Basic.to_string
       (`Assoc
          ([
             ("op", `String "attach");
             ("name", `String "size");
             ("rows", `Int rows);
             ("cols", `Int cols);
           ]
          @ fields)));
  let kind, reply = read_frame socket in
  expect "a control reply first" (kind = 'C');
  expect "attached" (member "ok" (Yojson.Basic.from_string reply) = `Bool true);
  socket

let claim = [ ("size", `String "claim") ]

let resize socket ?mode (rows, cols) =
  write_frame socket 'R'
    (Yojson.Basic.to_string
       (`Assoc
          ([ ("rows", `Int rows); ("cols", `Int cols) ]
          @ Option.fold ~none:[] ~some:(fun m -> [ ("size", `String m) ]) mode)))

let check label expected actual = Alcotest.(check string) label expected actual

let first_claim_owns_later_claims_follow () =
  with_host (fun socket_path ->
      let desk = attach ~fields:claim socket_path (40, 116) in
      check "the first claim sets the size" "40x116 you" (next_size desk);
      let phone = attach ~fields:claim socket_path (33, 52) in
      check "a later claim does not change it" "40x116 other" (next_size phone);
      check "the owner is told again" "40x116 you" (next_size desk);
      resize phone ~mode:"claim" (33, 52);
      check "a follower's automatic size is ignored" "40x116 other"
        (next_size phone);
      check "the owner keeps it" "40x116 you" (next_size desk);
      resize desk ~mode:"claim" (30, 100);
      check "the owner's own fit applies" "30x100 you" (next_size desk);
      check "the follower follows" "30x100 other" (next_size phone);
      resize phone ~mode:"keep" (29, 100);
      check "a follower's redraw applies, the owner stays" "29x100 you"
        (next_size desk);
      check "for the follower too" "29x100 other" (next_size phone);
      resize phone ~mode:"take" (33, 52);
      check "an explicit take-over moves it" "33x52 you" (next_size phone);
      check "the former owner follows" "33x52 other" (next_size desk);
      resize desk ~mode:"take" (40, 116);
      check "the last take-over wins" "40x116 you" (next_size desk);
      check "and the other follows" "40x116 other" (next_size phone);
      resize phone ~mode:"steal" (10, 10);
      no_size phone 0.3;
      Unix.close desk;
      check "the owner left: nobody owns" "40x116 none" (next_size phone);
      resize phone ~mode:"claim" (33, 52);
      check "the next claim takes it" "33x52 you" (next_size phone);
      Unix.close phone)

let former_clients_take_the_size () =
  with_host (fun socket_path ->
      let desk = attach ~fields:claim socket_path (40, 116) in
      check "owner" "40x116 you" (next_size desk);
      let former = attach socket_path (24, 80) in
      check "an attach without the field takes the size, as before"
        "24x80 other" (next_size desk);
      no_size former 0.3;
      resize former (30, 90);
      check "a resize without the field takes it too" "30x90 other"
        (next_size desk);
      Unix.close former;
      check "its departure frees the size" "30x90 none" (next_size desk);
      Unix.close desk)

let () =
  let argv = Sys.argv in
  if Array.length argv < 2 then
    invalid_arg
      "usage: ptyhost_size_owner_test 'HOST [ARGS]' [alcotest options]";
  host_argv :=
    Array.of_list (List.filter (( <> ) "") (String.split_on_char ' ' argv.(1)));
  Alcotest.run
    ~argv:
      (Array.append [| argv.(0) |] (Array.sub argv 2 (Array.length argv - 2)))
    "PTY host size owner"
    [
      ( "two clients",
        [
          Alcotest.test_case "the first claim owns, later claims follow" `Quick
            first_claim_owns_later_claims_follow;
          Alcotest.test_case "clients without the field take the size" `Quick
            former_clients_take_the_size;
        ] );
    ]
