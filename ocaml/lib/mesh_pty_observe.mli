(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type t
(** A candidate-only, bounded and local observation sink. It has no access to
    session names, terminal bytes, commands, paths, tokens or PIDs. *)

type event =
  | Create
  | Attach
  | Detach
  | Kill
  | Resize
  | Input of int
  | Output of int
  | Exit
      (** Only allowlisted operation families and bounded byte-count classes. *)

val create :
  directory:string ->
  basename:string ->
  now:Mtime.t ->
  lifetime:float ->
  max_events:int ->
  t
(** Create a new 0600 regular file inside an owner-private, non-symlink
    directory. Reject pre-existing files, the reserved PTY socket name, and
    unsafe names or directories. The deadline uses a monotonic timestamp. *)

val with_sink :
  directory:string ->
  basename:string ->
  now:Mtime.t ->
  lifetime:float ->
  max_events:int ->
  (t -> 'a) ->
  'a
(** Bracket the complete candidate startup/run lifecycle: any exception after
    sink creation closes and unlinks that sink immediately. *)

val record : t -> now:Mtime.t -> event -> unit
(** Queue a bounded metadata event without file I/O. Full or expired sinks
    ignore subsequent events. Never performs file I/O or raises to the PTY call
    site; the worker performs expiry cleanup. *)

val drain : t -> unit
(** Flush queued events. On I/O failure, retire the sink. *)

val tick : t -> now:Mtime.t -> unit
(** Flush pending events or expire when the deadline has passed. *)

val active : t -> bool
(** Whether the sink can still accept events. *)

val expire : t -> unit
(** Close the sink and remove its original file, if still at its original inode.
    Idempotent. *)
