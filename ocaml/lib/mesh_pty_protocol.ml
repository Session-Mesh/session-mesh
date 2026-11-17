(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let read_frame_internal ?control_bound flow =
  let header = Cstruct.create 5 in
  Eio.Flow.read_exact flow header;
  (match control_bound with
  | None -> ()
  | Some bound ->
      let length =
        Int64.logand
          (Int64.of_int32 (Cstruct.BE.get_uint32 header 1))
          0xffff_ffffL
      in
      if Cstruct.get_char header 0 <> 'C' || length > Int64.of_int bound then
        raise End_of_file);
  let bytes = Cstruct.to_string header in
  match Mesh_wire.decode bytes with
  | Error (Mesh_wire.Payload_too_large _) -> raise End_of_file
  | _ -> (
      let length = Int32.to_int (Cstruct.BE.get_uint32 header 1) in
      let body = Cstruct.create length in
      Eio.Flow.read_exact flow body;
      match Mesh_wire.decode (bytes ^ Cstruct.to_string body) with
      | Ok (frame, _) -> frame
      | _ -> raise End_of_file)

let read_frame flow = read_frame_internal flow

let read_control_frame ~max_payload flow =
  if max_payload < 0 || max_payload > Mesh_wire.max_small_frame then
    invalid_arg "control frame bound";
  read_frame_internal ~control_bound:max_payload flow

let size fields =
  let number = function
    | `Int value -> float_of_int value
    | `Float value -> value
    | `Bool value -> if value then 1. else 0.
    | `String value ->
        let value = String.trim value in
        let first =
          if String.length value > 0 && (value.[0] = '+' || value.[0] = '-')
          then 1
          else 0
        in
        if String.length value = first then invalid_arg "size";
        let digit i = value.[i] >= '0' && value.[i] <= '9' in
        for i = first to String.length value - 1 do
          if
            (not (digit i))
            && not
                 (value.[i] = '_'
                 && i > first
                 && i + 1 < String.length value
                 && digit (i - 1)
                 && digit (i + 1))
          then invalid_arg "size"
        done;
        (* Python accepts arbitrarily large decimal integers. Their geometry
           is clamped, so float overflow is representable only in this branch. *)
        float_of_string value
    | _ -> invalid_arg "size"
  in
  let dimension key =
    let raw =
      match List.assoc_opt key fields with
      | Some value -> value
      | None -> invalid_arg "size"
    in
    let value = number raw in
    if
      (not (Float.is_finite value))
      && match raw with `String _ -> false | _ -> true
    then invalid_arg "size";
    if value < 2. then 2
    else if value >= 65535. then 65535
    else int_of_float value
  in
  try (dimension "rows", dimension "cols")
  with Failure _ -> invalid_arg "size"

(* OCaml waitpid uses negative Sys.sig* encodings. The supported platform is
   Linux; unknown positive values (including realtime signals) are native. *)
let signal_code value =
  let signals =
    [
      (Sys.sighup, 1);
      (Sys.sigint, 2);
      (Sys.sigquit, 3);
      (Sys.sigill, 4);
      (Sys.sigtrap, 5);
      (Sys.sigabrt, 6);
      (Sys.sigbus, 7);
      (Sys.sigfpe, 8);
      (Sys.sigkill, 9);
      (Sys.sigusr1, 10);
      (Sys.sigsegv, 11);
      (Sys.sigusr2, 12);
      (Sys.sigpipe, 13);
      (Sys.sigalrm, 14);
      (Sys.sigterm, 15);
      (Sys.sigchld, 17);
      (Sys.sigcont, 18);
      (Sys.sigstop, 19);
      (Sys.sigtstp, 20);
      (Sys.sigttin, 21);
      (Sys.sigttou, 22);
      (Sys.sigurg, 23);
      (Sys.sigxcpu, 24);
      (Sys.sigxfsz, 25);
      (Sys.sigvtalrm, 26);
      (Sys.sigprof, 27);
      (Sys.sigpoll, 29);
      (Sys.sigsys, 31);
    ]
  in
  match List.assoc_opt value signals with
  | Some number -> -number
  | None when value > 0 -> -value
  | None -> invalid_arg "unknown signal encoding"
