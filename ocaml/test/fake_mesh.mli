(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** A fake one-shot mesh on a loopback port, and mesh-logout-all run against it
    in a private configuration directory. *)

val token : string
(** The master token of {!with_conf}. *)

val contents : string -> string
val write_file : string -> string -> unit

val with_conf : (string -> 'a) -> 'a
(** A configuration directory holding the token and generation 5, removed
    afterwards. *)

val generation_file : string -> string

(** What the fake mesh does once it has read the request. *)
type behaviour =
  | Answer of string  (** Sends the text, then closes. *)
  | Answer_then_stall of string
      (** Sends the text and keeps the connection open. *)
  | Answer_then_reset of string
      (** Sends the text and, a moment later, resets the connection. *)
  | Flood of string * string
      (** A prefix, then the second text again and again until killed. *)
  | Stall  (** Sends nothing and keeps the connection open. *)
  | Close  (** Closes without a byte. *)
  | Reset  (** Resets the connection without a byte. *)

val with_mesh : behaviour -> (int -> 'a) -> 'a * string
(** [with_mesh behaviour f] runs [f port] against a child process that accepts
    one connection and behaves. The result comes with the request the mesh
    received, [""] when none reached it. *)

val closed_port : unit -> int
(** A loopback port nothing listens on. *)

type run = { code : int; out : string list; err : string list }

val run :
  ?timeout:float ->
  ?args:string list ->
  ?extra:(string * string) list ->
  string ->
  int ->
  run
(** [run conf port] is {!Mesh_logout_all.run} with [MESH_CONF_DIR] and
    [MESH_PORT] set, [extra] first; its exit code and the lines it printed. *)

val contains : string -> string -> bool
(** [contains text fragment]. *)

val check_no_token : run -> unit
(** Fails when a printed line holds {!token}. *)

val http : string -> ?headers:string -> string -> string
(** [http status body]: an HTTP/1.1 answer with its [Content-Length]. *)
