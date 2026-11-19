(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Hostile requests and texts: every one is refused with [invalid_input]
    (exit 2) and writes nothing, except the texts that are valid at the
    limits, which are recorded as given. *)

val tests : unit Alcotest.test_case list
