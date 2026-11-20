(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Who owns the size of a PTY that several clients show.

    A program on the main screen (Claude Code's footer, for one) redraws only
    its visible rows for the width it reads; a client narrower than that width
    wraps every row and keeps copies of the footer in its scrollback. So one
    client, the owner, sets the size, and the others display at that size.

    - The first client that attaches with a claim while nobody owns the size
      sets it and owns it.
    - A claim (an automatic fit, a socket opening) while another client owns the
      size changes nothing.
    - An explicit take-over always applies and moves the ownership: the last one
      wins. A resize without the [size] field (every client before this rule) is
      a take-over, as before.
    - A redraw ([Keep]) applies and never moves the ownership.
    - When the owner detaches, nobody owns the size until the next claim. *)

type mode =
  | Take  (** explicit take-over, or the former protocol *)
  | Claim  (** applies only when nobody else owns the size *)
  | Keep  (** applies; the owner stays the owner *)

val mode_of_fields : (string * Yojson.Basic.t) list -> mode option
(** The [size] field of an R frame or of an attach request: absent is [Take];
    ["take"], ["claim"] and ["keep"]; anything else is [None] (refused). *)

type 'client decision = { apply : bool; owner : 'client option }
(** Whether to apply the geometry, and the owner afterwards. *)

val resize :
  same:('client -> 'client -> bool) ->
  owner:'client option ->
  client:'client ->
  mode ->
  'client decision

val detach :
  same:('client -> 'client -> bool) ->
  owner:'client option ->
  client:'client ->
  'client option
(** The owner after [client] detached. *)

type role = You | Other | Nobody

val role :
  same:('client -> 'client -> bool) ->
  owner:'client option ->
  client:'client ->
  role

val frame_payload : rows:int -> cols:int -> role -> string
(** The JSON payload of the S frame a watching client receives:
    [{"rows":R,"cols":C,"owner":"you"|"other"|"none"}]. *)
