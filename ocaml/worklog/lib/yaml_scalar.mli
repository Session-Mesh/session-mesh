(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Implicit scalar typing of YAML 1.1, as PyYAML's safe loader (the one the
    [wl] tool uses) resolves plain scalars. *)

val is_plain_string : string -> bool
(** Whether an unquoted scalar is read as a string: [false] for the
    booleans, null, integers (decimal, [0x], [0b], octal with a leading [0],
    base 60), floats and timestamps. [2fa], [3d], [1e3], [4b] and [0o17] are
    strings. *)

val numeric_like : string -> bool
(** The wider, conservative test: starts like a number and uses only
    characters numbers use. A superset of what {!is_plain_string} refuses. *)

val is_conservative_string : string -> bool
(** [is_plain_string s && not (numeric_like s)]: what is accepted for a
    {e new} id written to a file, which no YAML version may read as a number. *)
