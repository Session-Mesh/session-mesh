(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A JSON-lines request server over a pair of Eio flows (a child process's
    stdin and stdout, or in-memory flows in tests), with the frames of
    {!Mesh_jsonl_rpc_envelope}.

    Lines are bounded in both directions: a request line over
    [max_request_bytes] is dropped without being held in memory and answered
    with [bad_request]; a final response over [max_response_bytes] is replaced
    by a [too_large] error; an oversized event is refused to the handler.
    Nesting is bounded before parsing ({!Mesh_jsonl_value}).

    Several requests may be in progress at once (up to [max_in_flight]): each
    is answered in its own fibre, every frame carries the request's [req],
    and frames are written whole, one at a time. *)

type config = {
  max_request_bytes : int;
  max_response_bytes : int;
  max_depth : int;
  max_in_flight : int;
}

val config :
  ?max_request_bytes:int ->
  ?max_response_bytes:int ->
  ?max_depth:int ->
  ?max_in_flight:int ->
  unit ->
  config
(** Defaults: 1 MiB requests, 4 MiB responses, depth 64, 4 requests in
    progress.
    @raise Invalid_argument if a value is below 1. *)

type emit = string -> Mesh_jsonl_rpc_envelope.fields -> (unit, [ `Too_large ]) result
(** Send an event of the current request: [emit name fields]. *)

type handler =
  Mesh_jsonl_rpc_envelope.request ->
  emit:emit ->
  (Mesh_jsonl_rpc_envelope.fields, Mesh_jsonl_rpc_envelope.error) result
(** The answer to one request. An exception other than a cancellation is
    answered with [internal] and a fixed message (its text could name local
    paths). An unknown operation should answer [Unknown_op]. *)

val serve : config -> handler -> _ Eio.Flow.source -> _ Eio.Flow.sink -> unit
(** Answer requests until the end of the input, then wait for the requests
    in progress. Blank lines are ignored; a last line without a newline is a
    request. *)

(** Bounded lines from a flow: also what a client reads responses with. *)
module Reader : sig
  type t

  val create : max_line_bytes:int -> _ Eio.Flow.source -> t

  val next : t -> Mesh_jsonl_lines.line option
  (** The next line, or [None] at the end of the input. *)
end

(** Whole frames to a flow, one at a time across fibres. *)
module Writer : sig
  type t

  val create : max_line_bytes:int -> _ Eio.Flow.sink -> t

  val write : t -> Yojson.Safe.t -> (unit, [ `Too_large ]) result
  (** Write the frame and a newline, or nothing when it is too large. *)
end
