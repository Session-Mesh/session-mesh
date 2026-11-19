(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The fold of a Codex rollout (one JSON object per line) into what the
    session list shows, ported from [discover._codex_transcript],
    [_codex_reply] and [_text_blocks]: the last prompt typed, the agent's last
    reply (every form Codex has written: [agent_message], [item_completed],
    [task_complete], an assistant [response_item]) and the working directory
    of the latest turn. The state is immutable and small: the texts are kept
    already cut to 240 code points. *)

type t

val fold : t Mesh_jsonl_tail.fold
val init : t
val step : t -> Yojson.Safe.t -> t

val last : t -> Yojson.Safe.t
val cwd : t -> Yojson.Safe.t
val said : t -> Yojson.Safe.t
(** Each [null] when unknown. *)
