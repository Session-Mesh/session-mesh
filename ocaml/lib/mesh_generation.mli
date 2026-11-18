(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The cookie generation on disk, read and raised as [cookiegen.py] does.

    The file ([cookie-generation] in the configuration directory) holds
    ["<n>\n"], mode 0600. Every [mesh_auth] cookie is bound to that number:
    raising it signs every browser out. A missing file is created at 0 (its
    directory at 0700, the file exclusively at 0600); a file that does not hold
    a non-negative integer is never read as 0, which would revive old cookies,
    but replaced by the clock in nanoseconds, which no counter reaches. A write
    goes to a new temporary file of mode 0600 beside the file, flushed to disk,
    then renamed over it, and the directory is flushed so that the rename
    survives a power loss: the running server sees a new inode and reads the
    file again. *)

type t = private int
(** A generation: a non-negative integer. *)

val file_name : string
(** ["cookie-generation"]. *)

val parse : string -> t option
(** The generation a file holds, read like Python's [int(text.strip())]: ASCII
    whitespace around, an optional sign, decimal digits with single underscores
    between them. A negative value, any other form, non-ASCII digits and a value
    above [max_int] give [None]. *)

val read : warn:(string -> unit) -> string -> (t, string) result
(** [read ~warn path] is the generation in [path], created at 0 when absent and
    repaired when damaged. A repair passes
    [session-mesh: <path> is not a generation number; every login is revoked] to
    [warn] before rewriting the file. Any other failure to read (a permission, a
    directory) is an [Error] with a one-line message, and nothing is written. *)

val create : string -> [ `Created | `Exists | `Failed of string ]
(** [create path] creates a missing file at ["0\n"], exclusively, mode 0600 (its
    directory at 0700). [`Exists] when the file is already there, for example
    created by another process after [read] found it missing: that file is left
    exactly as it is, and [read] reads it again. *)

val bump : warn:(string -> unit) -> string -> (t, string) result
(** [bump ~warn path] raises the generation by one, writes it atomically and
    returns it. There is no lock between the read and the write, as in
    [cookiegen.bump]. *)

val write : string -> t -> (unit, string) result
(** [write path generation] replaces [path] with ["<generation>\n"], mode 0600,
    in one step. An [Error] from flushing the directory comes after the rename:
    [path] may then already hold [generation]. *)
