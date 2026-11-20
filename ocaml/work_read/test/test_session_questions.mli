(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Tests of [session-questions]: the counts by session (asked, about a linked
    task, about the project of a linked task, never twice), what each question
    is about, the request form, the caps and the absence of paths. *)

val tests : unit Alcotest.test_case list
