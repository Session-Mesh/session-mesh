(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* What the carry modules share: the refusal, and lstat and readdir that turn
   a system error into one. *)

type error = { code : string; message : string }

let login_files = [ ".credentials.json"; ".claude.json"; "auth.json" ]

(* Bounds on what one conversation may hold. *)
let max_files = 20_000
let max_depth = 8
let chunk = 65536
let fail code message = Error { code; message }
let ( let* ) = Result.bind

let lstat_opt path =
  match Unix.lstat path with
  | stats -> Ok (Some stats)
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok None
  | exception Unix.Unix_error (error, _, _) ->
      fail "carry_failed" (Unix.error_message error)

let readdir path =
  match Sys.readdir path with
  | names -> Ok (List.sort String.compare (Array.to_list names))
  | exception Sys_error message -> fail "carry_failed" message

let join folder relative = folder ^ "/" ^ relative
