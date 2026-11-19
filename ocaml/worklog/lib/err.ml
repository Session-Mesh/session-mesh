(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type kind = Usage | Not_found | Malformed | Lock_timeout | Repo | Other
type t = { kind : kind; message : string }

exception E of t

let make kind message = { kind; message }
let fail kind message = raise (E { kind; message })
let usage fmt = Printf.ksprintf (fun m -> fail Usage m) fmt
let not_found fmt = Printf.ksprintf (fun m -> fail Not_found m) fmt

let exit_code = function
  | Usage -> 2
  | Not_found -> 3
  | Malformed -> 4
  | Lock_timeout -> 5
  | Repo -> 6
  | Other -> 1

let to_string e = e.message

let unwrap = function Ok v -> v | Error e -> raise (E e)

let protect f =
  try Ok (f ()) with
  | E e -> Error e
  | Unix.Unix_error (code, fn, arg) ->
      Error
        {
          kind = Other;
          message = Printf.sprintf "%s %s: %s" fn arg (Unix.error_message code);
        }
  | Sys_error m -> Error { kind = Other; message = m }

let reraise_fatal = function (Sys.Break | Out_of_memory) as e -> raise e | _ -> ()
