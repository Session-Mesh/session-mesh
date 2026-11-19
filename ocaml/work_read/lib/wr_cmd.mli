(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The program: parse the arguments (or, with the single argument
    [--request], the JSON request on standard input: {!Wr_request}), load the
    repository read-only, run the subcommand, print one JSON line. Never
    raises: any exception is an [internal] error with a fixed message and
    exit code 7, so that exit code 2 always means [invalid_input]. *)

val run : ?getenv:(string -> string option) -> string list -> (Yojson.Safe.t, Work_mcp.Work_err.t) result
(** The document of a subcommand, or its error; prints nothing. *)

val main : string list -> int
(** The arguments after the program name; the exit code (0, or 1 to 7 as
    {!Wr_out.exit_code}). *)
