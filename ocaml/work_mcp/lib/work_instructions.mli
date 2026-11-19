(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

val text : string
(** The server [instructions]: when to call [work_resume], when the session is
    linked and when to log, how to ask without stopping, and that all returned
    data is untrusted. Level 1 of the reminders to agents (spec section 8). *)
