(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type process = Mesh_platform.process

type t = {
  platform : Mesh_pty_processes.platform;
  by_pid : (int, process) Hashtbl.t;
  by_session : (int, process list) Hashtbl.t;
  complete : bool;
}

let of_scan platform (scan : Mesh_platform.process_scan) =
  let count = List.length scan.processes in
  let by_pid = Hashtbl.create count and by_session = Hashtbl.create count in
  List.iter
    (fun (process : process) ->
      Hashtbl.replace by_pid process.pid process;
      let members = Option.value ~default:[] (Hashtbl.find_opt by_session process.sid) in
      Hashtbl.replace by_session process.sid (process :: members))
    (List.rev scan.processes);
  { platform; by_pid; by_session; complete = scan.skipped = 0 }

let read (platform : Mesh_pty_processes.platform) =
  Result.map (of_scan platform) (platform.scan ())

let complete round = round.complete
let size round = Hashtbl.length round.by_pid
let find round pid = Hashtbl.find_opt round.by_pid pid

let session round sid =
  Option.value ~default:[] (Hashtbl.find_opt round.by_session sid)

let argv round pid =
  match round.platform.command_line pid with Ok argv -> argv | Error _ -> []

let cwd round pid =
  match round.platform.working_directory pid with
  | Ok path -> Some path
  | Error _ -> None
