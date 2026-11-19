(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The frames of a JSON-lines request protocol, as values: no input or
    output here (see {!Mesh_jsonl_rpc}).

    It keeps the convention of [mesh-history] ([Mesh_history_protocol]): a
    request is [{"req": <any, optional, echoed>, "op": <name>, ...}]; a final
    response is [{"req": ..., "ok": true, ...}] or
    [{"req": ..., "ok": false, "error": {"code": ..., "message": ...}}]. It
    adds two things:

    - streamed events: an operation may send any number of
      [{"req": ..., "event": <name>, ...}] frames before its final response.
      A frame with ["ok"] always ends its request; a frame with ["event"]
      never does;
    - a version: every frame this module encodes carries ["v": 1]. A request
      without ["v"] is version 1; one with a higher version is refused with
      [unsupported_version], so that a newer peer learns it at once.

    The reserved keys [v], [req], [op], [ok], [error] and [event] are set by
    this module: a field of the same name supplied by the caller is dropped. *)

val version : int
(** [1]. *)

type code =
  | Bad_request  (** ["bad_request"]: not JSON, not an object, no [op], line too long. *)
  | Unsupported_version  (** ["unsupported_version"]. *)
  | Unknown_op  (** ["unknown_op"]. *)
  | Too_large  (** ["too_large"]: the response would exceed the output bound. *)
  | Internal  (** ["internal"]: the handler raised. *)
  | Code of string  (** An operation's own code, sent as it is. *)

val code_to_string : code -> string
val code_of_string : string -> code

type error = { code : code; message : string }
type fields = (string * Yojson.Safe.t) list

type request = {
  req : Yojson.Safe.t option;  (** Echoed in every frame of the answer. *)
  op : string;
  request_version : int;
  fields : fields;  (** Every field of the request object, reserved ones included. *)
}

val decode_request :
  Mesh_jsonl_value.limits -> string -> (request, Yojson.Safe.t option * error) result
(** A request line. On error, the [req] to echo when it could be read. *)

val request : ?req:Yojson.Safe.t -> string -> fields -> Yojson.Safe.t
(** A request frame for operation [op]. *)

val ok : Yojson.Safe.t option -> fields -> Yojson.Safe.t
val error : Yojson.Safe.t option -> error -> Yojson.Safe.t
val event : Yojson.Safe.t option -> string -> fields -> Yojson.Safe.t

type frame =
  | Event of { req : Yojson.Safe.t option; name : string; fields : fields }
  | Final of { req : Yojson.Safe.t option; result : (fields, error) result }

val decode_frame : Mesh_jsonl_value.limits -> string -> (frame, error) result
(** A response line, for a client. [fields] exclude the reserved keys. *)
