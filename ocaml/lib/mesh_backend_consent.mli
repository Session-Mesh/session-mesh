(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

type confirmation = Ask | Skip
type choice = Once | Remember_pair | Remember_global
type basis = Default | Global | Pair_ask | Pair_never

type error =
  | Invalid_policy
  | Invalid_account
  | Invalid_pair
  | Conflict
  | Revision_exhausted
  | Capacity

type account
type t
type decision = { confirmation : confirmation; basis : basis; revision : int }

val error_code : error -> string
(** Fixed error projection, without authored input or account paths. *)

val account :
  backend:Mesh_backend_profile.backend ->
  id:string ->
  context_revision:string ->
  (account, error) result
(** Validated reference, not proof of native account identity or authority. *)

val empty : unit -> t
(** Default Ask policy at revision zero. *)

val revision : t -> int
(** Monotonic JS-safe management revision. *)

val of_string : string -> (t, error) result
(** Strict bounded version-one policy decoding. *)

val to_string : t -> string
(** Canonical policy JSON; no credentials, labels or conversation bodies. *)

val decide : t -> source:account -> target:account -> (decision, error) result
(** Ask pair exception, valid Never-ask pair, global setting, then default. *)

val set_global :
  t -> expected_revision:int -> confirmation:confirmation -> (t, error) result
(** Revision-checked global management edit, including compatible future
    profiles. *)

val set_pair :
  t ->
  expected_revision:int ->
  source:account ->
  target:account ->
  confirmation:confirmation ->
  (t, error) result
(** Revision-checked unordered exact pair rule; no labels or transitive
    equivalence. *)

val remove_pair :
  t ->
  expected_revision:int ->
  source:account ->
  target:account ->
  (t, error) result
(** Remove the exact pair and fall back to the current global/default policy. *)

val remove_pair_ids :
  t ->
  expected_revision:int ->
  backend:Mesh_backend_profile.backend ->
  source_id:string ->
  target_id:string ->
  (t, error) result
(** Remove a rule for registered or retired IDs without inventing native
    context. *)

val reset : t -> expected_revision:int -> (t, error) result
(** Every management edit checks and advances its revision, even a logical
    no-op. *)

val commit_choice :
  t ->
  expected_revision:int ->
  source:account ->
  target:account ->
  choice ->
  (t, error) result
(** Pure staged-choice application. The caller must atomically persist this
    result with the successful switch journal commit. No native effect is
    authorized here. *)
