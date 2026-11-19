(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The output of one invocation: a single JSON document on stdout, bounded,
    with every string cleaned, or an error document and a non-zero exit code.
    Nothing here prints a path: error messages go through
    {!Work_mcp.Work_err.safe_text}. *)

val max_output_bytes : int
(** 1_000_000. A longer document is cut by {!Wr_fit.fit} (stored data stays
    readable); only one that cannot be cut further is an [output_too_large]
    error. *)

val reset : unit -> unit
(** Clear the [truncated] flag (one invocation per process; tests call it). *)

val mark_truncated : unit -> unit
(** Record that some list or text was cut. *)

val list : string -> int -> Yojson.Safe.t list -> (string * Yojson.Safe.t) list
(** [key: items] with at most [n] items; when some were cut, also
    [key_omitted] (the count) and the document's [truncated] flag. *)

val text : max:int -> string -> Yojson.Safe.t
(** A cleaned string, cut at [max] bytes on a character boundary; a cut sets
    the [truncated] flag. *)

val document : string -> (string * Yojson.Safe.t) list -> Yojson.Safe.t
(** [document command fields]: [schema], [command], the fields, [truncated]. *)

val error_document : Work_mcp.Work_err.t -> Yojson.Safe.t
(** [{"error": {"code", "message"}}]. *)

val exit_code : Work_mcp.Work_err.t -> int
(** 2 [invalid_input], 3 [not_found], 4 [malformed_data], 5 [lock_timeout],
    6 [repository], 7 [internal] (an unexpected exception), 1 anything else
    ([io_error], [output_too_large]). *)

val finish : (Yojson.Safe.t, Work_mcp.Work_err.t) result -> int
(** Print the document (or the error) as one compact line and return the exit
    code. The whole tree is cleaned of control, bidirectional and invisible
    characters first, then brought under {!max_output_bytes} by {!Wr_fit.fit}. *)
