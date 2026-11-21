(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(** Stop the agent a session's shell runs in the foreground, and keep the shell,
    its terminal and its attachments: the [stop_agent_if] operation of the
    native PTY host, which lets the agent be started again in the same terminal
    (a restart, or a switch to another account).

    A session's leader is its shell; the agent is a job the shell started from a
    typed command, in a process group of its own that holds the terminal. The
    rules here read a process table ({!Mesh_platform.process}) and are pure; the
    signals, the clock and the table come from the caller. *)

type foreground =
  | Idle
      (** The shell holds the terminal and no process of the session runs the
          agent: there is nothing to stop. *)
  | Running of int
      (** The process group of the foreground job, which runs the agent. *)
  | Refused of string
      (** Nothing may be signalled; the reason, as the reply names it:
          - [process_scan_failed]: the leader is not in the table;
          - [no_terminal]: the leader has no controlling terminal;
          - [no_shell]: the leader is the agent itself, so stopping it would end
            the session;
          - [unsupported_foreground]: another program holds the terminal;
          - [agent_not_foreground]: a process of the session runs the agent
            outside the foreground job (in the background, or in the shell's own
            group). *)

val classify :
  runs_agent:(Mesh_platform.process -> bool) ->
  leader:int ->
  Mesh_platform.process list ->
  foreground
(** What holds the terminal of the session led by [leader], from one table.
    [runs_agent] tells whether a process runs the requested agent. *)

val gone :
  runs_agent:(Mesh_platform.process -> bool) ->
  leader:int ->
  group:int option ->
  Mesh_platform.process list ->
  bool
(** The agent is gone: the leader holds the terminal again, no live process (a
    zombie runs nothing) remains in [group], and no live process of the session
    other than the leader runs the agent. *)

type timing = {
  grace : float;  (** Seconds between SIGHUP and SIGKILL. *)
  kill_wait : float;  (** Seconds after SIGKILL before giving up. *)
  poll : float;  (** Seconds between two readings of the table. *)
}

val default_timing : timing
(** 3 s, 1 s and 0.05 s: the whole stop fits in the 5 s a client of the host
    waits for a reply. [MESH_PTYHOST_AGENT_STOP_GRACE] replaces [grace] when it
    is a finite number between 0 and 3. *)

val stop :
  timing ->
  signal:(int -> unit) ->
  sleep:(float -> unit) ->
  now:(unit -> float) ->
  stopped:(unit -> bool) ->
  [ `Stopped | `Still_running ]
(** Send SIGHUP to the job (the signal a closed terminal sends), wait until
    [stopped ()] holds or [grace] elapsed, then send SIGKILL and wait up to
    [kill_wait] more. [`Still_running] when the job outlived both: the caller
    then starts nothing. *)
