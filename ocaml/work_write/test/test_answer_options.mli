(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The owner's edit of an answer (a new owner-verified answer that supersedes
    the earlier one, both kept) and the structured [choices] of an answer to a
    question with options, checked against the question's kind and options. *)

val tests : unit Alcotest.test_case list
