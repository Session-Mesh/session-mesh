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
