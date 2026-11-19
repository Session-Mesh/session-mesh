(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Durable appends and exclusive creation of files. *)

val append : ?root:string -> string -> string -> unit
(** [append path blob] appends [blob] with a single write on an [O_APPEND]
    descriptor, then [fsync]s. If the file already holds bytes and does not
    end with a newline (a torn last line), a newline is written first, in the
    same write. The directory is created if needed.

    The file is opened with {!Safefs.open_create}: a symbolic link or a file
    that is not regular is refused. With [?root], every directory below
    [root] down to the parent of [path] must be a real directory (never a
    link); without it only the parent is checked. *)

val mkdir_p : string -> unit
(** Create a directory and its missing parents. *)

val create_exclusive : ?root:string -> string -> string -> unit
(** Write a new file with [O_EXCL] (never overwriting, never following a link),
    then [fsync]. The directory is created (and checked) as for {!append}. Raises {!Err.E} ([Other]) if the file
    exists. *)

val last_byte_is_newline : string -> bool
(** [true] for a missing or empty file. *)

val tail : string -> int -> string
(** The last [n] bytes of a file (all of it when shorter), or [""] when the
    file is missing. *)
