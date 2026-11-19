(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Symlink-safe file access for the data repository. Task files, event
    files, the [events/] and [tasks/<product>/] directories and [.wl.lock] are
    never reached through a symbolic link, and anything that is not a regular
    file (or, for directories, a real directory) is refused. The same helpers
    serve reads and writes.

    A file is opened first and then checked: the descriptor's file type and
    its device and inode must equal those {!Unix.lstat} reports for the path,
    so a link swapped in between the two steps is caught. A missing file is
    created with [O_EXCL] (which never follows a link) and then opened like an
    existing one, so a dangling link is never written through. Directory
    components are checked with [lstat] just before use; a local attacker
    changing a directory component in that short window is out of scope, as
    in [wl].

    Refusals raise {!Err.E} (kind [Other]); I/O errors raise
    {!Unix.Unix_error}. Both are turned into [Error] by {!Err.protect}. *)

val kind : string -> Unix.file_kind option
(** File type of the path itself, without following a final link; [None] when
    it does not exist. *)

val is_regular_file : string -> bool
(** A regular file, not a link to one. *)

val is_real_dir : string -> bool
(** A directory, not a link to one. *)

val is_file_following : string -> bool
(** A regular file or a link to one (for [taxonomy.yaml] discovery). *)

val max_read_bytes : int
(** Size limit of an event or task file read (64 MiB). *)

val max_taxonomy_bytes : int
(** Size limit of a [taxonomy.yaml] read (1 MiB). *)

val read_file : ?limit:int -> string -> string
(** The whole content of a regular file, at most [limit] bytes (default
    {!max_read_bytes}). Raises when the path is a link, not a regular file or
    larger than [limit]. *)

val read_file_following : ?limit:int -> string -> string
(** As {!read_file} but a link to a regular file is followed
    ([taxonomy.yaml]); the type is checked on the opened descriptor, which is
    opened [O_NONBLOCK], so a FIFO never blocks. *)

val read_file_result : ?limit:int -> string -> (string, string) result
(** {!read_file} with the failure reason as text. *)

val open_regular : string -> Unix.open_flag list -> Unix.file_descr
(** Open an existing regular file ([O_CLOEXEC] and [O_NONBLOCK] are added;
    do not pass [O_CREAT] or [O_TRUNC]). The path is checked with [lstat]
    before it is opened (OCaml's [Unix] has no [O_NOFOLLOW]) and the
    descriptor after, so a special file swapped in meanwhile is opened without
    blocking and then refused. *)

val open_create : string -> Unix.open_flag list -> Unix.file_descr
(** As {!open_regular}, creating the file (mode 0644) first when it does not
    exist. *)

val list_dir : string -> string list
(** The sorted names in a real directory; [[]] when the path is absent, a
    link or not a directory. A directory that cannot be read raises. *)

val make_dirs : ?root:string -> string -> unit
(** Create a directory. With [root], every component below [root] down to the
    directory must be a real directory (created when missing); without it,
    only the directory itself is checked. Raises on a link or a file. *)

val resolve_inside : root:string -> string -> string
(** [Unix.realpath] of a path, which must lie strictly inside [realpath root];
    raises {!Err.E} (kind [Usage]) otherwise. *)
