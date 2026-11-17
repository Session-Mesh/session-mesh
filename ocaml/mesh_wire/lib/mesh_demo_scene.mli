(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Closed, non-executable [mesh-scene-v0] and bounded local-state
    [mesh-scene-v1]/[mesh-scene-v2] admission for runner-owned revisions. The
    JSON version is the published revision, not the proposed CAS base. *)

type error = Too_large | Malformed | Invalid

val validate_published : expected_revision:int -> string -> (unit, error) result
(** Refuse unknown or duplicate fields and node kinds, invalid UTF-8, excessive
    text/nesting/node/state/choice counts, dangling transition targets and a
    mismatched revision. The caller still has to prove that the exact native
    session is live. *)
