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

val takes_value : string list
(** The options of [_CODEX] (its [keep_value] and [drop_value]) that take a
    value. *)

val flags : string list
(** The options of [_CODEX] (its [keep_flag] and [drop_flag]) that take none.
    [fixtures/codex/options.json] holds both lists; a test checks that it
    equals these and another that it equals Python's [_CODEX]. *)

val python_lower : string -> string option
(** Python's [str.lower] on UTF-8 text: the full lowercase mapping of
    {!Uucp.Case.Map.to_lower} with CPython's final-sigma rule; ASCII text
    takes a fast path. [None] when the text is not valid UTF-8 (Python's
    [surrogateescape] text, which matches no conversation id). Code points
    that Python's Unicode database and Uucp's differ on (one may be a newer
    Unicode version) may lower differently. *)

val may_name : string list -> string option -> bool
(** Whether launch words may name this conversation: one word equals its id
    under {!python_lower}, or a [resume] word is there and {!resumed_id}
    reads none (an unreadable launch counts as a claim). For a conversation
    whose id is unknown ([None]), only the second rule applies: no word can
    equal it, but an unreadable launch may still be on it. *)
