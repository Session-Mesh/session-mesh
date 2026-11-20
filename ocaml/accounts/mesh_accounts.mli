(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Agent account aliases declared by the operator on the runner.

    An alias groups at most one Claude configuration folder
    ([CLAUDE_CONFIG_DIR]) and at most one Codex home ([CODEX_HOME]) under a
    short id and a label. A session started with an alias runs its agent with
    the matching variable; with no alias (the implicit [default]) nothing
    changes. The file is [accounts.json] in the Mesh configuration folder,
    written by hand:

    {v
    {"v": 1, "accounts": [
      {"id": "work", "label": "Work", "claude_config_dir": "/home/me/.agent-accounts/work/.claude",
       "codex_home": "/home/me/.agent-accounts/work/.codex"}]}
    v}

    The whole file is refused when any part of it is invalid: no alias is then
    offered. Mesh never reads, copies or shows what is inside the folders (the
    credentials the agents keep there): it only checks the folders and hands
    their paths to the agent. *)

type account = {
  id : string;  (** [[a-z0-9-]{1,32}], never [default]. *)
  label : string;  (** 1 to 24 characters, no control character. *)
  claude_config_dir : string option;
  codex_home : string option;
}

val max_bytes : int
(** Largest accepted file, in bytes. *)

val max_accounts : int

val valid_id : string -> bool
(** [[a-z0-9-]{1,32}] and not [default]. *)

val valid_label : string -> bool

val valid_path : string -> bool
(** Absolute, normalised (no empty, [.] or [..] component, no trailing slash),
    at most 1024 bytes, made of [A-Za-z0-9._+@/-] only: the path is written on a
    shell command line, so nothing in it may need quoting. *)

val parse : string -> (account list, string) result
(** The structure of the file's text: exactly the fields above, unique ids, no
    folder declared twice. The file system is not looked at. *)

val check_directory : uid:int -> string -> (unit, string) result
(** A declared folder as it is now: no component of the path is a symbolic link;
    when it exists it is a directory owned by [uid] that neither group nor
    others can write; when it does not exist its parent exists, is owned by
    [uid] and is not writable by others (it can then be created). *)

val prepare_directory : uid:int -> string -> (unit, string) result
(** {!check_directory}, then create the folder with mode 0700 when it is
    missing, and check it again. *)

val load : uid:int -> string -> (account list, string) result
(** Read the file (a regular file, not a link, at most {!max_bytes}), {!parse}
    it and {!check_directory} every folder. *)

val to_json : account -> Yojson.Safe.t
