(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* How Mesh_local_http reads a failed system call. On XNU (macOS) a socket a
   refusal or a reset tore down refuses setsockopt and getpeername with
   EINVAL; no Linux peer can cause that, so the errors are fed directly. *)

let describe = function
  | Mesh_local_http.Success _ -> "Success"
  | Refused _ -> "Refused"
  | Unreadable message -> "Unreadable: " ^ message
  | No_answer message -> "No_answer: " ^ message
  | Failed message -> "Failed: " ^ message

let check_failure ~received ~call error expected () =
  Alcotest.(check string)
    "outcome" expected
    (describe (Mesh_local_http.socket_failure ~received ~call error))

let reset = "No_answer: " ^ Unix.error_message Unix.EINVAL
let during = "Unreadable: the connection failed during the answer"

let failure name ~received ~call error expected =
  Alcotest.test_case name `Quick (check_failure ~received ~call error expected)

let classified =
  ( "socket errors",
    [
      failure "EINVAL from setsockopt, before any byte" ~received:false
        ~call:"setsockopt_float" Unix.EINVAL reset;
      failure "EINVAL from setsockopt, after the first byte" ~received:true
        ~call:"setsockopt_float" Unix.EINVAL during;
      failure "EINVAL from getpeername" ~received:false ~call:"getpeername"
        Unix.EINVAL reset;
      failure "ECONNRESET from read, before any byte" ~received:false
        ~call:"read" Unix.ECONNRESET
        ("No_answer: " ^ Unix.error_message Unix.ECONNRESET);
      failure "EINVAL from another call is local" ~received:false ~call:"read"
        Unix.EINVAL
        ("Failed: read: " ^ Unix.error_message Unix.EINVAL);
      failure "EMFILE from socket is local" ~received:false ~call:"socket"
        Unix.EMFILE
        ("Failed: socket: " ^ Unix.error_message Unix.EMFILE);
      failure "ENOMEM after the first byte is local" ~received:true ~call:"read"
        Unix.ENOMEM
        ("Failed: read: " ^ Unix.error_message Unix.ENOMEM);
    ] )

let check_peer_name ~pending error expected () =
  let shown =
    match Mesh_local_http.peer_name_error ~pending error with
    | None -> "wait"
    | Some (error, call) -> call ^ ": " ^ Unix.error_message error
  in
  Alcotest.(check string) "decision" expected shown

let peer_name name ~pending error expected =
  Alcotest.test_case name `Quick (check_peer_name ~pending error expected)

let connecting =
  ( "connection in progress",
    [
      peer_name "ENOTCONN, nothing pending: wait" ~pending:None Unix.ENOTCONN
        "wait";
      peer_name "EINVAL, refusal pending: the refusal"
        ~pending:(Some Unix.ECONNREFUSED) Unix.EINVAL
        ("connect: " ^ Unix.error_message Unix.ECONNREFUSED);
      peer_name "ENOTCONN, reset pending: the reset"
        ~pending:(Some Unix.ECONNRESET) Unix.ENOTCONN
        ("connect: " ^ Unix.error_message Unix.ECONNRESET);
      peer_name "EINVAL, nothing pending: getpeername's" ~pending:None
        Unix.EINVAL
        ("getpeername: " ^ Unix.error_message Unix.EINVAL);
      peer_name "EBADF, nothing pending: getpeername's" ~pending:None Unix.EBADF
        ("getpeername: " ^ Unix.error_message Unix.EBADF);
    ] )

let () = Alcotest.run "mesh_local_http" [ classified; connecting ]
