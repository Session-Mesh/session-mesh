(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Release versions, ordered as semantic versions (semver.org, section 11).

    A version is [MAJOR.MINOR.PATCH] with an optional [-PRERELEASE] suffix of
    dot-separated identifiers, optionally preceded by [v] as in a release tag.
    Build metadata ([+...]) and leading zeros are refused. *)

type t = private { major : int; minor : int; patch : int; pre : string list }

val parse : string -> t option
(** [None] when the text is not a version. *)

val compare : t -> t -> int
(** Semantic version precedence: [v1.10.0] after [v1.9.0], a pre-release before
    its release, [rc.10] after [rc.9]. *)

val is_prerelease : t -> bool

val to_string : t -> string
(** Without the [v] prefix. *)
