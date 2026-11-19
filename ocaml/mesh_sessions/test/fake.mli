(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Fictional process tables and homes for the tests of mesh-sessions: no
    real process is read, and every file lives in a temporary directory. *)

type process = {
  pid : int;
  ppid : int;
  sid : int;
  pgrp : int;
  tpgid : int;
  comm : string;
  argv : string list;
  cwd : string option;
}

val process :
  ?ppid:int -> ?pgrp:int -> ?tpgid:int -> ?argv:string list -> ?cwd:string -> pid:int -> sid:int -> string -> process
(** Defaults: parent 1, group the session, no terminal ([-1]), argv the
    name, no working directory. *)

val platform : ?on_read:(int -> unit) -> ?skipped:int -> process list -> Mesh_pty_processes.platform
(** [on_read pid] runs before each command-line read (a test makes one slow). *)

val round : ?skipped:int -> process list -> Mesh_agent_round.t

val session : int -> Mesh_agent.session
(** The listed session led by this pid, named [s<pid>]. *)

val write : string -> string -> unit
(** Create the parent directories, then write the file. *)

val claude_home :
  home:string -> pid:int -> ?metadata:Yojson.Safe.t -> ?project:string -> ?transcript:string -> unit -> unit
(** Write [~/.claude/sessions/<pid>.json] and the transcript of its
    [sessionId] under [~/.claude/projects/<project>]. *)

val registry : string -> Mesh_agent.Registry.t
(** The program's registry (the Claude adapter) for a fixture home. *)

val canonical : Yojson.Safe.t -> Yojson.Safe.t
(** Keys sorted, integers as floats: for comparing rows with Python's. *)
