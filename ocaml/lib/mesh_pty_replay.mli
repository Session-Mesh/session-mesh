(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t
(** Byte-preserving terminal replay, bounded to two MiB. *)

val create : unit -> t
val snapshot : t -> string

val is_empty : t -> bool
(** Whether [snapshot] would be empty, without copying it. *)

val birth_bytes : t -> string option
(** [Some bytes] contains every opaque byte fed since creation, including an
    empty origin. Once any trim occurs this is permanently [None], even if the
    retained buffer later becomes empty. This attests byte completeness only: no
    geometry history, VT screen state or authorization is implied. *)

val feed : t -> string -> unit
(** Append opaque output, trimming on a newline or after a crossing escape
    sequence/UTF-8 continuation. No screen emulation is performed: the bytes
    trimmed are only scanned for the terminal modes of {!Mesh_pty_modes}. *)

val replay : t -> string
(** What an attaching client receives: [snapshot], preceded, once a trim has cut
    the start of the output, by the {!Mesh_pty_modes.prefix} of the bytes
    trimmed, so that the client parses the window in the modes it was written
    in. Exactly [snapshot] while nothing was trimmed. *)

module Raw : sig
  type t
  (** Exact-byte cursor storage; offsets are routing data, not authority. Fixed
      [capacity] byte storage and O(1) metadata. Legacy replay is unchanged. *)

  type error = Overflow | Invalid_cursor | Invalid_state | Gap

  val capacity : int
  val create : unit -> t
  val floor : t -> int64
  val head : t -> int64
  val replay_end : t -> int64

  val checked_advance : offset:int64 -> length:int -> (int64, error) result
  (** Pure overflow check used by append, without any mutable counter setter. *)

  val append : t -> string -> (unit, error) result
  (** Overflow seals future append; retained reads remain available. *)

  val mark_initial_replay : t -> (unit, error) result
  (** One-shot immediately after the first append, including an empty snapshot.
  *)

  val read : t -> offset:int64 -> maximum:int -> (string * bool, error) result
  (** At most 32768 bytes; stops at replay boundary. Evicted offsets are [Gap],
      future offsets [Invalid_cursor]. Empty at head is not replay. *)
end
