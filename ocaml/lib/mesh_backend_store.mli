(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

type error =
  | Unsafe_store
  | Unavailable
  | Conflict
  | Invalid_state
  | Unsupported_version
  | Aborted
  | Busy
  | Capacity

type t
type transaction

val error_code : error -> string
(** Fixed public error code; SQL errors and private paths are never returned. *)

val open_ : root:string -> unit -> (t, error) result
(** Open the private versioned store under an existing trusted configuration
    root. *)

val close : t -> (unit, error) result
(** Close outside a transaction; concurrent/nested use refuses instead of
    deadlocking. *)

val read_policy : t -> (Mesh_backend_consent.t, error) result
(** Read checked policy; corrupt or inconsistent state never becomes default
    Ask. *)

val transaction :
  t ->
  expected_revision:int ->
  (transaction -> ('a, error) result) ->
  ('a, error) result
(** Atomically fence the policy revision and commit policy/journal writes
    together. The callback must perform only store operations, never native
    process effects. Failed accessors poison the transaction even if their error
    is ignored. *)

val policy : transaction -> (Mesh_backend_consent.t, error) result
(** Read the current staged policy within the callback lifetime. *)

val set_policy : transaction -> Mesh_backend_consent.t -> (unit, error) result
(** Stage unchanged policy or exactly one checked revision increment. *)

val get_operation :
  transaction -> id:string -> (Yojson.Safe.t option, error) result
(** Read a bounded internal journal row within the callback lifetime. *)

val put_operation :
  transaction -> id:string -> Yojson.Safe.t -> (unit, error) result
(** Bounded internal journal storage, not an external API or switch
    authorization. Actual phase/authority validation belongs to the qualified
    switch coordinator. *)

val finish_operation : transaction -> id:string -> (unit, error) result
(** Mark an existing journal row terminal and immutable. Only the qualified
    coordinator may call this after establishing no recovery is pending; the
    store cannot infer completion from the opaque payload. No external API. *)

val purge_finished : transaction -> (int, error) result
(** Remove terminal rows only, returning the count. Active or uncertain rows are
    never evicted to make capacity. This rolls back with policy/journal writes
    on failure; retention timing belongs to the coordinator. *)
