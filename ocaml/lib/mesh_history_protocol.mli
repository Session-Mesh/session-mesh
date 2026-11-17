(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The JSON-lines protocol of [mesh-history]: one request object per line on
    the input, one response object per line on the output, in order.

    A request is [{"req": <any, optional, echoed>, "op": <name>, ...}]. A
    response is [{"req": ..., "ok": true, ...}] or
    [{"req": ..., "ok": false, "error": {"code": ..., "message": ...}}].

    Operations: [hello], [ingest], [forget], [list], [detail], [search],
    [cursors], [stats]. Error codes: ["bad_request"], ["busy"] (database
    locked), ["corrupt"], ["db"]. The process never exits on a bad request or
    a database error: it answers with an error and retries opening the
    database on the next request. *)

type t

val create : open_store:(unit -> (Mesh_history_store.t, Mesh_history_store.error) result) -> t
(** [open_store] is called lazily, again after each failure. *)

val handle_line : t -> string -> string
(** The response line (without newline) for one request line. *)

val serve : t -> in_channel -> out_channel -> unit
(** Answer every line until end of input; flushes after each response. *)

val protocol_version : int
