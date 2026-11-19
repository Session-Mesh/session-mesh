(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** The Codex scenarios of fixtures/codex/scenarios.json (the format is
    described there) built for the OCaml side: the rollouts are written in a
    temporary home, the process table is a fictional platform. The TS parity
    test builds the same scenarios as a fake /proc for the Python side. *)

type spec

val load : string -> spec
val btime : spec -> float
val names : spec -> string list

type built = {
  platform : Mesh_pty_processes.platform;
  home : string;
  root : string;  (** Replaced by [$ROOT] in the compared rows. *)
  labels : (string * int) list;
}

val build : spec -> string -> root:string -> now:float -> built
(** [build spec name ~root ~now]: write the scenario [name] under [root]. *)

type process = {
  pid : int;
  ppid : int;
  sid : int;
  comm : string;
  start : float;  (** Seconds since the epoch. *)
  argv : string list;
  cwd : string option;
  files : ((int * string) list, Mesh_platform.error) result;
  zombie : bool;
  uid : int;  (** The owner: this test's user, unless a scenario says otherwise. *)
}

val platform : btime:float -> process list -> Mesh_pty_processes.platform
(** Start times become Linux clock ticks after [btime] (100 per second), or
    microseconds since the epoch on macOS, as each backend reports them. Every
    session has a terminal whose foreground group is the session's own. *)

val config : btime:float -> now:float -> Mesh_agent_codex.config
(** A fixed clock and boot time, no registry. *)

val write_rollout : home:string -> ?day:string -> name:string -> mtime:float -> string -> string
(** Write [~/.codex/sessions/<day>/rollout-<name>.jsonl]; its path. *)

val header : id:string -> cwd:string -> string
(** A [session_meta] first line (with its newline). *)

val replace_all : sub:string -> by:string -> string -> string

val session : int -> Mesh_agent.session
(** The listed session of the agent of this pid, named [s<pid>]. *)

val describe : Mesh_agent_codex.t -> Mesh_agent_round.t -> int -> Mesh_agent.fields
(** Describe the process of this pid for {!session}. *)
