(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Tests of the [context] of the questions of [resume]: task title, project,
    product and category; nothing for a question about nothing or an unknown
    id; present in a scoped [resume]; absent from [task]. *)

val tests : unit Alcotest.test_case list
