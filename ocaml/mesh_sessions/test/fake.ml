(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

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

let process ?(ppid = 1) ?pgrp ?(tpgid = -1) ?argv ?cwd ~pid ~sid comm =
  {
    pid;
    ppid;
    sid;
    pgrp = Option.value ~default:sid pgrp;
    tpgid;
    comm;
    argv = Option.value ~default:[ comm ] argv;
    cwd;
  }

let to_platform (fake : process) : Mesh_platform.process =
  {
    pid = fake.pid;
    ppid = fake.ppid;
    pgrp = fake.pgrp;
    sid = fake.sid;
    tpgid = fake.tpgid;
    comm = fake.comm;
    state = 'S';
    incarnation = 0L;
  }

let platform ?(on_read = ignore) ?(skipped = 0) processes : Mesh_pty_processes.platform =
  let sorted = List.sort (fun a b -> compare a.pid b.pid) processes in
  let find pid = List.find_opt (fun fake -> fake.pid = pid) sorted in
  let lookup f pid = match find pid with Some fake -> f fake | None -> Error Mesh_platform.Not_found in
  {
    scan = (fun () -> Ok { Mesh_platform.processes = List.map to_platform sorted; skipped });
    process = lookup (fun fake -> Ok (to_platform fake));
    command_line =
      (fun pid ->
        on_read pid;
        lookup (fun fake -> Ok fake.argv) pid);
    working_directory =
      lookup (fun fake -> Option.to_result ~none:Mesh_platform.Denied fake.cwd);
    open_file_paths = (fun _ -> Error (Mesh_platform.Unsupported "fake"));
  }

let round ?skipped processes =
  match Mesh_agent_round.read (platform ?skipped processes) with
  | Ok round -> round
  | Error _ -> failwith "fake table"

let rec mkdir_p directory =
  if not (Sys.file_exists directory) then begin
    mkdir_p (Filename.dirname directory);
    Unix.mkdir directory 0o700
  end

let write path contents =
  mkdir_p (Filename.dirname path);
  Out_channel.with_open_bin path (fun channel -> Out_channel.output_string channel contents)

let claude_home ~home ~pid ?metadata ?(project = "-work") ?transcript () =
  let claude = Filename.concat home ".claude" in
  Option.iter
    (fun metadata ->
      write
        (Filename.concat (Filename.concat claude "sessions") (string_of_int pid ^ ".json"))
        (Yojson.Safe.to_string metadata);
      match (Yojson.Safe.Util.member "sessionId" metadata, transcript) with
      | `String id, Some text ->
          write (String.concat "/" [ claude; "projects"; project; id ^ ".jsonl" ]) text
      | _ -> ())
    metadata

let registry home =
  Mesh_agent.Registry.create [ Mesh_agent.adapter (module Mesh_agent_claude) (Mesh_agent_roots.of_home home) ]

let rec canonical = function
  | `Assoc fields ->
      `Assoc (List.sort (fun (a, _) (b, _) -> String.compare a b) (List.map (fun (k, v) -> (k, canonical v)) fields))
  | `List items -> `List (List.map canonical items)
  | `Int number -> `Float (float_of_int number)
  | value -> value
