(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Where the mesh keeps its state, and the port of the local mesh: the rules of
    [meshpaths.py], for the native command-line programs.

    [MESH_CONF_DIR] and [MESH_CACHE_DIR], when unset or empty, are
    [~/.config/session-mesh] and [~/.cache/session-mesh]. A set value must be an
    absolute path. [MESH_PORT], when unset or empty, is 7690; otherwise it must
    be one to five ASCII digits naming a port between 1 and 65535. Every error
    is the one-line message of [meshpaths.py], to print on stderr before exiting
    with status 1. *)

type getenv = string -> string option
(** How a variable of the environment is read ([Sys.getenv_opt], or a fixed
    environment in tests). *)

val conf_dir : getenv -> (string, string) result
(** The configuration directory, normalised like Python's [pathlib]: no
    repeated, trailing or [.] component. *)

val cache_dir : getenv -> (string, string) result
(** The cache directory, with the same rules. *)

type port
(** A port number between 1 and 65535. *)

val port_number : port -> int

val port : getenv -> (port, string) result
(** The port named by [MESH_PORT]. Hexadecimal ([0x1E5A]), underscores
    ([7_690]), a sign ([+7690]), spaces and non-ASCII digits are refused. *)
