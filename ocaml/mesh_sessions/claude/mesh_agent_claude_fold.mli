(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The fold of a Claude transcript (one JSON object per line) into the fields
    the session list shows, ported from [discover.claude_info] and its helpers
    ([_claude_said], [_claude_choices], [_claude_ask], [_clip]).

    The state is immutable and small: the text fields are kept already cut
    ([last] and [said] to 240 code points, each choice to 40), so a state
    holds a few kilobytes whatever the transcript's size. Cutting each value
    as it is kept gives the fields Python computes by cutting the last value
    at the end. *)

type t

val fold : t Mesh_jsonl_tail.fold
(** For {!Mesh_jsonl_tail.update}. Its [step] never raises. *)

val init : t
val step : t -> Yojson.Safe.t -> t

val fields : t -> Mesh_agent.fields
(** [title], [last], [cwd], [said], [choices] and [ask_id], each [null] when
    unknown. The question's choices are kept only when the message that asks
    it uses no other tool. *)
