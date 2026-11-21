(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type foreground = Idle | Running of int | Refused of string

let live (found : Mesh_platform.process) = found.state <> 'Z'

(* Live processes of the session other than its leader that run the agent. *)
let agents ~runs_agent ~leader table =
  List.filter
    (fun (found : Mesh_platform.process) ->
      found.sid = leader && found.pid <> leader && live found
      && runs_agent found)
    table

(* Whether [found] is an agent process or one of its descendants (its tools),
   following [ppid] through [table]; a cycle or a missing parent ends the walk. *)
let from_agent ~runs_agent table (found : Mesh_platform.process) =
  let parent_of pid =
    List.find_opt (fun (other : Mesh_platform.process) -> other.pid = pid) table
  in
  let rec walk (current : Mesh_platform.process) steps =
    runs_agent current
    || steps > 0
       &&
       match parent_of current.ppid with
       | Some parent when parent.pid <> current.pid -> walk parent (steps - 1)
       | _ -> false
  in
  walk found (List.length table)

(* A live process of the shell's own group, other than the shell, that is
   neither an agent nor started by one: a program a person runs there. *)
let other_program_in_shell_group ~runs_agent ~leader table =
  List.exists
    (fun (found : Mesh_platform.process) ->
      found.pgrp = leader && found.pid <> leader && live found
      && not (from_agent ~runs_agent table found))
    table

let classify ~runs_agent ~leader table =
  match
    List.find_opt
      (fun (found : Mesh_platform.process) -> found.pid = leader)
      table
  with
  | None -> Refused "process_scan_failed"
  | Some shell when runs_agent shell -> Refused "no_shell"
  | Some shell when shell.tpgid <= 0 -> Refused "no_terminal"
  | Some shell -> (
      let running = agents ~runs_agent ~leader table in
      let job = shell.tpgid in
      match
        List.partition
          (fun (found : Mesh_platform.process) -> found.pgrp = job)
          running
      with
      | [], [] when job = leader -> Idle
      (* Every agent process is in the shell's own group: a shell without job
         control, whose group only a stop of the whole session may signal.
         Unless another program shares that group: it is never stopped. *)
      | _ :: _, [] when job = leader ->
          if other_program_in_shell_group ~runs_agent ~leader table then
            Refused "unsupported_foreground"
          else Refused "no_job_control"
      | _ when job = leader -> Refused "agent_not_foreground"
      | [], _ -> Refused "unsupported_foreground"
      | _ :: _, [] -> Running job
      | _ :: _, _ :: _ -> Refused "agent_not_foreground")

let gone ~runs_agent ~leader ~group table =
  match
    List.find_opt
      (fun (found : Mesh_platform.process) -> found.pid = leader)
      table
  with
  | None -> false
  | Some shell ->
      shell.tpgid = leader
      && (match group with
        | None -> true
        | Some group ->
            not
              (List.exists
                 (fun (found : Mesh_platform.process) ->
                   found.pgrp = group && live found)
                 table))
      && agents ~runs_agent ~leader table = []

(* Ctrl-E (end of line) then Ctrl-U (erase back to its start): readline, zsh
   and fish line editors, and a terminal's own erase-line key without one. *)
let clear_line = "\x05\x15"

type timing = { grace : float; kill_wait : float; poll : float }

let configured_grace () =
  match
    Option.bind (Sys.getenv_opt "MESH_PTYHOST_AGENT_STOP_GRACE") (fun value ->
        float_of_string_opt (String.trim value))
  with
  | Some seconds when Float.is_finite seconds && seconds >= 0. && seconds <= 3.
    ->
      seconds
  | _ -> 3.

let default_timing =
  { grace = configured_grace (); kill_wait = 1.; poll = 0.05 }

let stop timing ~signal ~sleep ~now ~stopped =
  let rec wait_until deadline =
    if stopped () then true
    else if now () >= deadline then false
    else (
      sleep timing.poll;
      wait_until deadline)
  in
  signal Sys.sighup;
  if wait_until (now () +. timing.grace) then `Stopped
  else (
    signal Sys.sigkill;
    if wait_until (now () +. timing.kill_wait) then `Stopped else `Still_running)
