(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Compile-only Eio API proof and bounded Yojson input/depth experiment. *)
let eio_api env sw =
  let terminal = Eio_unix.Pty.open_pty ~sw () in
  let process =
    Eio_unix.Process.spawn_unix ~sw
      (Eio.Stdenv.process_mgr env)
      ~login_tty:(Eio_unix.Pty.tty terminal)
      ~fds:[] [ "/bin/bash"; "-l" ]
  in
  let listener =
    Eio.Net.listen ~sw ~backlog:16 (Eio.Stdenv.net env)
      (`Unix "/not-executed-preflight.sock")
  in
  ignore (Eio.Process.pid process);
  Eio.Net.accept_fork ~sw ~on_error:ignore listener (fun _ _ -> ())

let parse = Mesh_ptyhost.parse

let () =
  ignore eio_api;
  (* Typechecked, never called: no listener or child is started. *)
  let attacks =
    [
      String.make 200000 '[';
      String.make 130000 '[' ^ "0" ^ String.make 130000 ']';
      "{\"op\":\"list\",\"meta\":" ^ String.make 100000 '[' ^ "0"
      ^ String.make 100000 ']' ^ "}";
    ]
  in
  List.iter
    (fun payload ->
      if Result.is_ok (parse payload) then failwith "deep input accepted";
      if Result.is_error (parse "{\"op\":\"list\"}") then
        failwith "parser unusable after refusal")
    attacks;
  let nested depth = String.make depth '[' ^ "0" ^ String.make depth ']' in
  if Result.is_error (parse (nested 128)) then failwith "depth 128 refused";
  if Result.is_ok (parse (nested 129)) then failwith "depth 129 accepted";
  let sized length = "0" ^ String.make (length - 1) ' ' in
  List.iter
    (fun size ->
      if Result.is_error (parse (sized size)) then
        failwith "in-bound size refused")
    [ Mesh_wire.max_small_frame - 1; Mesh_wire.max_small_frame ];
  if parse (sized (Mesh_wire.max_small_frame + 1)) <> Error "size" then
    failwith "oversize parsed";
  let multibyte_sized size =
    let prefix = "\"é\"" in
    prefix ^ String.make (size - String.length prefix) ' '
  in
  List.iter
    (fun size ->
      if Result.is_error (parse (multibyte_sized size)) then
        failwith "valid multibyte boundary refused")
    [ Mesh_wire.max_small_frame - 1; Mesh_wire.max_small_frame ];
  if parse (multibyte_sized (Mesh_wire.max_small_frame + 1)) <> Error "size"
  then failwith "multibyte oversize parsed";
  if Result.is_ok (parse "{\"op\":\"list\",\"ignored\":\"\255\"}") then
    failwith "invalid UTF8 accepted";
  if Result.is_error (parse "{\"op\":\"list\",\"ignored\":\"é\"}") then
    failwith "valid UTF8 control refused";
  if parse "{\"op\":\"list\"}" <> Ok (`Assoc [ ("op", `String "list") ]) then
    failwith "ordinary control rejected";
  print_endline
    "Yojson bounded-size/depth probes passed; Eio listener/PTY APIs compile \
     only"
