(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [work-read --request]: the request of the server route, read as JSON from
    standard input, [{"op": ..., "args": {...}}]. It is turned into the words
    of a command line and then checked by {!Wr_args.parse}, so the two forms
    obey the same strict rules; a request never becomes the argv of a
    process. *)

val max_bytes : int
(** 4096: a longer request is [invalid_input]. *)

val read : in_channel -> (string, Work_mcp.Work_err.t) result
(** The whole channel, at most {!max_bytes} bytes. *)

val parse : string -> (string list, Work_mcp.Work_err.t) result
(** The command-line words of a request: [op] (one of the subcommands) first;
    then, per argument, [id] as the identifier, [all] (only [true]) as
    [--all], any other name [n] with a string value [v] as [--n v]. Anything
    else (not JSON, not an object, an unknown or repeated top-level field, a
    missing op, [args] not an object, a value of the wrong type) is
    [invalid_input]. *)
