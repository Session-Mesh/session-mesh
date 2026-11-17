(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type kind = Claude | Codex
type t
type error = Invalid

val of_json : Yojson.Basic.t -> (t, error) result
(** Exact normalized runner-local profile emitted by resumeargs.py. This
    validates shape and fingerprint, not launch authority or file custody. Never
    use this parser as a client argv ingress. *)

val new_claude : conversation_id:string -> (t, error) result
(** Resume profile for a runner-selected fresh Claude UUID, with no extra
    options. This does not select a launcher, directory, or authority. *)

val to_json : t -> Yojson.Basic.t
val kind : t -> kind
val conversation_id : t -> string
val arguments : t -> string list
val fingerprint : t -> string

val selector : t -> source:string -> receipt:string -> cwd:string -> string
(** Deterministic opaque association only. Callers validate provenance and
    custody independently; this is neither a signature nor permission. *)
