(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The pure, bounded wire codec shared with a future OCaml ptyhost.

    A frame is exactly one byte of kind, a four-byte big-endian payload length,
    and that many opaque payload bytes. Decoding never allocates a declared
    payload before its kind-specific bound has been checked. *)

type frame = { kind : char; payload : string }

type decode_error =
  | Incomplete_header
  | Incomplete_payload
  | Payload_too_large of { kind : char; declared : int64; maximum : int }

val max_small_frame : int
val max_data_frame : int

val encode : frame -> string
(** Encode a frame. Raises [Invalid_argument] when its payload exceeds the same
    bound enforced by [decode]. *)

val decode : string -> (frame * string, decode_error) result
(** Decode one complete frame and return unconsumed bytes. *)

val verify_session_token :
  master_token:string -> string -> (string * string) option
(** Verify a Python-compatible [ms1.<name>.<nonce>.<mac>] token.

    The returned pair is [(name, nonce)]. This proves only that [master_token]
    minted the token; liveness and recorded-nonce checks stay with the host. *)
