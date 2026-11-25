(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type source =
  | Missing
  | Contents of string
  | Unreadable of Unix.error

exception Parent_exited
(** The server supplied [MESH_CONVERSATION_PARENT_PID] and the helper is no
    longer a child of that process. *)

val transact : path:string -> (source -> 'a * string option) -> 'a
(** Hold the exclusive BSD flock on the sibling [.lock] file while reading
    [path], running the callback once, and atomically replacing [path] if the
    callback returns [Some contents]. Lock, write and callback exceptions
    propagate. When the expected parent PID is set, check it before waiting,
    after acquiring the lock and before committing. The callback decides how
    to handle missing or unreadable input.
    It must not recursively acquire the same lock. *)

val transact_then : path:string -> (source -> (unit -> 'a) * string option) -> 'a
(** Like [transact], but the returned function computes the result under the
    lock after a successful replacement, or immediately if no write was
    requested. A failed write skips the function. If the function raises,
    its exception propagates and any completed replacement remains in place. *)
