(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Structured errors of the tools. Every failure of a tool, whatever its
    source, ends as one of these and is reported as an MCP error result
    [{"error": {"code", "message"}}]; none is raised. *)

type t = { code : string; message : string }
(** [code] is one of [invalid_input], [not_found], [malformed_data],
    [lock_timeout], [repository], [io_error], [internal], [not_available],
    [output_too_large] (a last-resort guard: a result is shrunk to fit). *)

val make : string -> string -> t
val invalid : ('a, unit, string, t) format4 -> 'a
val not_found : ('a, unit, string, t) format4 -> 'a

val of_worklog : Mesh_worklog.Err.t -> t
(** The kind of a library error becomes the code. A [repository] or [io_error]
    message is replaced by a fixed text, any other message has its absolute
    paths replaced; the detail goes to stderr only when [WORK_MCP_DEBUG] is set. *)

val sanitise : string -> string
(** Replace every path by [<path>]: an absolute or [~] path, a flag glued to a
    path ([-C/srv/x]), a relative path of two or more components, wherever it
    follows a space, a quote (ASCII or typographic) or other punctuation. URLs
    stay readable, except [file://], whose path is replaced. *)

val has_control : string -> bool
(** Contains a control character other than newline and tab: C0, DEL or C1
    (including carriage return and ESC). *)

val strip_controls : string -> string
(** Remove those control characters. *)

val safe_text : string -> string
(** Invalid UTF-8 repaired, {!sanitise}, then {!Work_text.clean} (control,
    bidirectional, zero-width and tag characters removed): the text of a
    message that leaves the server. *)

val debug_detail : string -> string -> unit
(** [debug_detail code raw] prints the raw text of an error to stderr, only when
    [WORK_MCP_DEBUG] is set. *)

val internal : string -> t
(** The error for an unexpected exception: a fixed message and the code
    [internal]; the raw text goes to stderr only when [WORK_MCP_DEBUG] is set. *)

val lift : ('a, Mesh_worklog.Err.t) result -> ('a, t) result
val to_json : t -> Yojson.Safe.t

val ( let* ) : ('a, 'e) result -> ('a -> ('b, 'e) result) -> ('b, 'e) result
