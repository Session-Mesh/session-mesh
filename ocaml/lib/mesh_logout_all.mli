(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** [mesh-logout-all]: sign every browser out of the mesh at once.

    It asks the running mesh, with the master token, to raise the cookie
    generation ([POST /api/logout-all]); when no mesh answers, it raises the
    generation on disk itself. A mesh that answers with an error is fatal and
    never leads to the disk: the error is reported and nothing is written.

    Checks, in the order of the Python command it replaces: [MESH_CONF_DIR] and
    [MESH_CACHE_DIR], the arguments (there are none), the token ([<conf>/token],
    trimmed), then [MESH_PORT]. *)

val usage : string
(** The text printed on stderr when an argument is given. *)

type output = { out : string -> unit; err : string -> unit }
(** Where the lines go: [out] for stdout, [err] for stderr. Each call is one
    line, without its newline. *)

val run :
  ?timeout:float ->
  getenv:Mesh_paths.getenv ->
  args:string list ->
  output ->
  int
(** [run ~getenv ~args output] does the whole command and returns its exit
    status: 0 when the revocation is confirmed (the mesh answered with the new
    generation, or the generation was raised on disk), 1 on any error. Exit 1
    does not prove that nothing was revoked: the mesh raises its generation
    before it answers, so an answer cut short or unreadable, or a line that
    cannot be written after the revocation, gives 1 although every login is
    revoked; running the command again only raises the generation once more. An
    error answer prevents the command's own write on disk, not a write the mesh
    already made. [args] excludes the program name. [timeout] (10 seconds by
    default) bounds the exchange with the mesh. *)
