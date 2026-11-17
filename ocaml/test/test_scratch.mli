(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

val short_temp_root : unit -> string
(** The canonical temporary directory ([Unix.realpath]), or the canonical [/tmp]
    when that one is longer than 40 bytes, so that a host socket a few
    components below a scratch directory fits [sun_path] (103 bytes on macOS,
    whose default temporary directory is too long). *)

val private_directory : string -> string
(** [private_directory prefix] creates and returns a new directory of mode 0700
    whose name starts with [prefix], under {!short_temp_root} or the nearest
    suitable directory above it. No directory above it is writable by group or
    others, except a sticky directory owned by root such as /tmp. The result
    does not depend on the caller's umask, nor on the mode of the temporary
    directory the test was given. The caller removes it.
    @raise Failure
      when no such place exists at or above the temporary directory. *)

val node : unit -> string
(** The canonical path ([Unix.realpath]) of the first executable [node] on
    [PATH]. A collector runtime must be absolute, and only some systems put
    [node] in /usr/bin: a GitHub runner has it in its tool cache, a Homebrew
    Mac in /opt/homebrew/bin.
    @raise Failure when no executable [node] is on [PATH]. *)
