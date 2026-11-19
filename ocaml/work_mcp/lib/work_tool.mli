(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Declaring a tool: strict input schemas, and one wrapper that turns every
    outcome into an MCP result. *)

val max_output_bytes : int
(** A true bound on the serialised result (JSON text, bytes). A longer result is
    shrunk at every depth until it fits: the value that takes most room loses
    half of it (a list its second half, with [<key>_omitted] counting what was
    cut; a string half of its characters), and [truncated] is [true]. A list
    keeps its head, except [answers] (time order: its newest items are kept)
    and [my_questions] (halved by group, open first; the three
    [my_*_omitted] counters follow). Invalid UTF-8, control, bidirectional,
    zero-width and tag characters are cleaned from every string first. Only a result that
    cannot shrink any further (not reached by stored data) is an
    [output_too_large] error. *)

val fit : ?max_bytes:int -> Yojson.Safe.t -> Yojson.Safe.t option
(** The result bounded to [max_bytes] (default {!max_output_bytes}) as
    described above; [None] only when nothing is left to cut. Exposed for the
    tests and for the [work-read] program, whose bound is larger. *)

val string : ?description:string -> ?max:int -> unit -> Mcp_kit.Schema.t
(** A non-empty string of at most [max] bytes (default 200). *)

val strings : ?max_items:int -> ?max:int -> unit -> Mcp_kit.Schema.t
val enum : string list -> Mcp_kit.Schema.t
val boolean : ?description:string -> unit -> Mcp_kit.Schema.t
val integer : ?description:string -> minimum:float -> maximum:float -> unit -> Mcp_kit.Schema.t

val object_ : (string * Mcp_kit.Schema.t) list -> required:string list -> Mcp_kit.Schema.t
(** An object schema that rejects every field it does not list. *)

val limit_property : max:int -> string * Mcp_kit.Schema.t

val error_result : Work_err.t -> Mcp_kit.Tool.result

val make :
  name:string ->
  description:string ->
  input_schema:Mcp_kit.Schema.t ->
  (Yojson.Safe.t -> (Yojson.Safe.t, Work_err.t) result) ->
  Mcp_kit.Tool.t
(** The handler gets the arguments and returns a JSON object or an error.
    Whatever it does, the call ends as a result: an exception becomes an
    [internal] error, the non-fatal problems of a write are added as
    [write_warnings], and the text and the structured content carry the same
    JSON. Arguments holding a control character (other than newline and tab)
    are refused with [invalid_input] before the handler runs. *)
