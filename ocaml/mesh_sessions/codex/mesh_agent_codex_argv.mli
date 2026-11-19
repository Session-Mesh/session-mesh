(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** What a Codex command line says about its conversation, ported from
    [resumeargs.resumed_codex_id], [agentcap.entry_args] (for Codex) and
    [discover._may_name]. Words are raw bytes: a byte that is not UTF-8 makes
    a word match nothing, as Python's [surrogateescape] text does.

    The option table is the Codex table of [resumeargs.py] ([_CODEX]); the
    two must change together until the Python one is retired. *)

val thread_id : string -> bool
(** A lowercase UUID ([agentwake.THREAD_RE]). *)

val entry_args : string list -> string list option
(** The words after Codex's entry point: its own binary ([codex]), [node]
    running [.../@openai/codex/bin/codex.js], or [npx]/[bunx] [[-y]]
    [@openai/codex[@version]]. [None] for any other shape. *)

val resumed_id : string list -> string option
(** [codex [options] resume <id>]: the id, when the options before [resume]
    are all known to the table and the word after it is a thread id. *)

val may_name : string list -> string -> bool
(** Whether launch words may name this conversation: one word equals it
    ignoring ASCII case, or a [resume] word is there and {!resumed_id} reads
    none (an unreadable launch counts as a claim). *)
