(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A request to the local mesh, the only place a command-line program sends its
    credential.

    The request goes straight to [http://127.0.0.1:<port><route>]: no proxy,
    whatever [http_proxy], [HTTPS_PROXY] or [all_proxy] say (the request is
    written on a plain TCP socket to the loopback address, and no proxy variable
    is read), and no redirection followed, so the [Authorization] header never
    reaches the host a [Location] names. *)

type authorization
(** The value of an [Authorization] header: no control character, so it cannot
    end the header line. *)

val bearer : string -> (authorization, string) result
(** [Bearer <token>]. A token holding an ASCII control character is refused with
    a message that does not quote it. *)

type outcome =
  | Success of string  (** A 2xx answer and its body. *)
  | Refused of { status : int; reason : string }
      (** Any other final HTTP status. [reason] is ["redirect refused"] for 301,
          302, 303, 307 and 308 (the redirection is not followed), the standard
          reason phrase otherwise. *)
  | Unreadable of string
      (** At least one byte of an answer was read, and what followed is not a
          complete, readable HTTP/1.x response within the limits: a malformed
          status line, length or chunk size; a status, header, chunk-size or
          trailer line longer than 64 KiB; more than 100 header or trailer
          lines; more than eight [100 Continue] answers; a body cut short or
          larger than 1 MiB; a socket error or the deadline reached after that
          first byte. The message is fixed text: it never quotes what was
          received. *)
  | No_answer of string
      (** Not one byte of an answer was read, and the peer is the cause: the
          connection was refused, or was closed, reset or failed before any
          byte, or the deadline passed in silence. This is the only outcome that
          means "nothing answered". On macOS a torn-down connection makes
          [setsockopt] and [getpeername] fail with [EINVAL]: that counts as the
          peer closing or resetting it (see {!socket_failure}). *)
  | Failed of string
      (** A local error stopped the exchange before any byte of an answer, or at
          any point after the first one: no descriptor or socket left, no
          memory, any error that is not the peer's. It says nothing about the
          mesh. The message names the system call and the error. *)

val post :
  ?timeout:float ->
  ?clock:(unit -> float) ->
  port:Mesh_paths.port ->
  route:string ->
  authorization ->
  unit ->
  outcome
(** [post ~port ~route authorization ()] sends an empty [POST] with
    [Content-Length: 0] and reads the answer. [clock] is the wall clock,
    [Unix.gettimeofday] by default (a test sets it back).

    One deadline ([timeout], 10 seconds by default) covers the connection, the
    request, the answer and its body: a budget of seconds that each wait, and
    the time between two waits, draws from, so a peer that never stops sending
    cannot postpone it. A wait lasts at most half a second and ends on a kernel
    timeout, so a silent peer ends the exchange after [timeout] seconds whatever
    the wall clock does. The wall clock only measures a wait that ends early and
    the time between waits: a step back counts as no time, so it postpones the
    end by at most half a second per step; a step forward counts in full between
    two waits, so it can end the exchange early.

    No [select]: the socket may have any descriptor number. What is kept in
    memory is bounded whatever the peer sends: one line of at most 64 KiB, at
    most 100 header fields, a body of at most 1 MiB.

    A [100 Continue] answer is skipped. A line the peer cuts before its end
    counts as a line, the end of the stream ends the headers and the trailers,
    and the first of several [Content-Length] fields counts, as for Python's
    [http.client]. *)

(** {2 Socket errors}

    How [post] reads a failed system call. Exposed so that a test can give it
    errors a Linux peer cannot cause. *)

val socket_failure : received:bool -> call:string -> Unix.error -> outcome
(** [socket_failure ~received ~call error] is the outcome of [error] raised by
    the system call [call] (the name {!Unix.Unix_error} carries). An error the
    peer or the way to it causes ([ECONNREFUSED], [ECONNRESET], [ECONNABORTED],
    [EPIPE], [ETIMEDOUT], [EHOSTUNREACH], [ENETUNREACH], [EHOSTDOWN],
    [ENETDOWN], and [EINVAL] from ["setsockopt_float"] or ["getpeername"], which
    is how XNU reports a socket a refusal or a reset tore down) is [No_answer]
    before the first byte of an answer and [Unreadable] once [received]. Any
    other is [Failed]. *)

val peer_name_error :
  pending:Unix.error option -> Unix.error -> (Unix.error * string) option
(** While a connection is in progress, what a failed [getpeername] means, given
    [pending], the socket's error ([SO_ERROR]) read just after it: [pending]
    when there is one, raised as a ["connect"] error; [None] (not connected yet,
    look again later) for [ENOTCONN]; else the error itself, as a
    ["getpeername"] error. *)
