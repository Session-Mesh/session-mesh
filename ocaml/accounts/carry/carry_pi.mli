(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type error = Carry_base.error = { code : string; message : string }

type outcome = {
  files : int;
  copied : int;
  replaced : int;
  unchanged : int;
  bytes : int;
}

val carry :
  ?io:Carry_write.io ->
  ?limits:Carry_base.limits ->
  uid:int ->
  source:string ->
  target:string ->
  conversation:string ->
  unit ->
  (outcome, error) result
(** Copy exactly one complete Pi v3 JSONL session, including its entire entry
    tree, between existing, validated sessions roots. The caller is responsible
    for selecting both account roots and stopping/checkpointing the source
    writer. No account registry, settings, credentials or unrelated session
    files are read for copying. Refuses non-UUID IDs, ambiguity, unsafe roots,
    malformed or unknown formats, divergent targets and incomplete rollback. *)
