(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Resolving user-typed references to ids. Each namespace is separate: a
    task reference never matches a project and the reverse. In every
    namespace an exact id beats a unique prefix. *)

val task : Model.world -> string -> (string, Err.t) result
(** [T-<hex>] or bare hex (any case), at least two hex digits. Unknown or
    ambiguous: [Not_found]; malformed: [Usage]; a [P-] id: [Not_found] naming
    the other namespace. *)

val project : Model.world -> string -> (string, Err.t) result
(** [P-<hex>] or bare hex, at least two hex digits; same errors. *)

val blocker : Model.task -> string -> (Model.blocker, Err.t) result
(** [B-<hex>] or a unique prefix, among the blockers of a task; a blocker that
    is already resolved is [Not_found]. *)

val open_blocker : Model.task -> string option -> (Model.blocker, Err.t) result
(** The blocker to resolve: the named one, or with no name the only open one.
    With several open and no name, [Not_found] listing them; with none,
    [Not_found]. *)
