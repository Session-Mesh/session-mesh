(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** One startup-fixed native registry. Hooks are explicit constructor inputs for
    private test fixtures; production startup exposes no fault switch. *)
type stage = Locked | Read | Temp_synced | Published | Directory_synced

type t

val make :
  ?hook:(stage -> unit) ->
  ?now:(unit -> float) ->
  root:string ->
  boot:string ->
  machine:(unit -> string) ->
  unit ->
  t

val startup_root : unit -> string
val observe_revision : t -> (string -> unit) -> unit
val capture : t -> machine_id:string -> project_id:string -> expected_revision:string -> Yojson.Basic.t * Yojson.Basic.t
exception Outcome of string * string
val run : t -> isolated:bool -> (string * Yojson.Basic.t) list -> Yojson.Basic.t

val error :
  ?fields:(string * Yojson.Basic.t) list ->
  t ->
  string ->
  string ->
  string ->
  Yojson.Basic.t
