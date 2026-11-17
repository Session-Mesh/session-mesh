(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Safe construction of FTS5 MATCH expressions from user input.

    The result is always a conjunction of quoted phrases whose characters are
    only letters and digits: no FTS5 operator ([AND], [OR], [NOT], [NEAR],
    [-], [^], [*], column filters, parentheses, quotes) typed by the user keeps
    its meaning. The expression is bound as a statement parameter, never
    concatenated into SQL. *)

val max_terms : int
(** At most this many terms are kept. *)

val max_term_bytes : int
(** Longer terms are truncated to this many bytes (on a UTF-8 boundary). *)

val match_expression : string -> string option
(** [match_expression q] is the MATCH expression for [q], or [None] when [q]
    holds no searchable term. Invalid UTF-8, NUL, control characters and
    punctuation are separators. The last term also matches as a prefix. *)
