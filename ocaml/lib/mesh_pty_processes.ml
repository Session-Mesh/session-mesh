(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module P = Mesh_platform

type platform = {
  scan : unit -> (P.process_scan, P.error) result;
  process : int -> (P.process, P.error) result;
  command_line : int -> (string list, P.error) result;
  working_directory : int -> (string, P.error) result;
  open_file_paths : int -> ((int * string) list, P.error) result;
}

let live =
  {
    scan = P.scan;
    process = P.process;
    command_line = P.command_line;
    working_directory = P.working_directory;
    open_file_paths = P.open_file_paths;
  }

type request = Table | Selected of int list

let max_selected = 64

let selected_pid = function
  | `Int pid when pid > 0 && pid <= 0x7fffffff -> pid
  | _ -> invalid_arg "pids"

let parse fields =
  match List.sort String.compare (List.map fst fields) with
  | [ "op" ] -> Table
  | [ "op"; "pids" ] -> (
      match List.assoc "pids" fields with
      | `List items when List.length items <= max_selected ->
          Selected (List.map selected_pid items)
      | _ -> invalid_arg "pids")
  | _ -> invalid_arg "keys"

let error_kind = function
  | P.Unsupported _ -> "unsupported"
  | P.Not_found -> "not_found"
  | P.Denied -> "denied"
  | P.Malformed _ -> "malformed"

let base_fields (p : P.process) =
  [
    ("pid", `Int p.pid);
    ("ppid", `Int p.ppid);
    ("pgrp", `Int p.pgrp);
    ("sid", `Int p.sid);
    ("tpgid", `Int p.tpgid);
    ("comm", `String p.comm);
    ("state", `String (String.make 1 p.state));
    ("incarnation", `String (Int64.to_string p.incarnation));
  ]

let strings values = `List (List.map (fun value -> `String value) values)
let or_null encode = function Ok value -> encode value | Error _ -> `Null

(* Names an agent can run under: the agents, and the interpreter of one (pi). *)
let agent_names =
  [ "claude"; "codex"; "pi"; "opencode"; "agy"; "copilot"; "vibe"; "vibe-rs"; "node"; "nodejs"; "node-MainThread" ]

let is_codex (p : P.process) argv =
  p.comm = "codex"
  ||
  match argv with
  | Ok (first :: _) -> Filename.basename first = "codex"
  | Ok [] | Error _ -> false

(* The descriptor-0 path and the open files, read once for both. *)
let file_fields platform (p : P.process) ~leader ~codex =
  let files = platform.open_file_paths p.pid in
  let stdin =
    match files with
    | Ok paths -> (
        match List.assoc_opt 0 paths with
        | Some path -> `String path
        | None -> `Null)
    | Error _ -> `Null
  in
  (if leader then [ ("stdin", stdin) ] else [])
  @
  if codex then
    [ ("open_files", or_null (fun l -> strings (List.map snd l)) files) ]
  else []

let detail_fields platform (p : P.process) =
  let terminal = p.tpgid > 0 in
  if not (terminal || List.mem p.comm agent_names) then []
  else
    let argv = platform.command_line p.pid in
    let leader = terminal && p.pid = p.sid and codex = is_codex p argv in
    [
      ("argv", or_null strings argv);
      ( "cwd",
        or_null (fun path -> `String path) (platform.working_directory p.pid) );
    ]
    @ if leader || codex then file_fields platform p ~leader ~codex else []

type candidate = {
  pid : int;
  rank : int;
  full : Yojson.Basic.t;
  base : Yojson.Basic.t;
  base_size : int;
  detail_size : int;
}

(* Which rows matter most when the table does not fit: 0 for what a client
   looks for (a session leader with a terminal, a process in its terminal's
   foreground group, a process with an agent name), 1 for any other process
   with a terminal, 2 for the rest. *)
let rank (p : P.process) =
  let terminal = p.tpgid > 0 in
  if
    (terminal && (p.pid = p.sid || p.pgrp = p.tpgid))
    || List.mem p.comm agent_names
  then 0
  else if terminal then 1
  else 2

let row_size row = String.length (Yojson.Basic.to_string row) + 1

let candidate platform (p : P.process) =
  let base = base_fields p in
  let full = `Assoc (base @ detail_fields platform p) and base = `Assoc base in
  let base_size = row_size base in
  {
    pid = p.pid;
    rank = rank p;
    full;
    base;
    base_size;
    detail_size = row_size full - base_size;
  }

let by_priority a b = compare (a.rank, a.pid) (b.rank, b.pid)

(* Bare rows in priority order, each one that still fits; all of them when the
   whole bare table fits. *)
let choose_bare budget candidates =
  List.fold_left
    (fun (chosen, used) c ->
      if used + c.base_size <= budget then (c :: chosen, used + c.base_size)
      else (chosen, used))
    ([], 0)
    (List.sort by_priority candidates)

(* Then details, in priority order, while they fit the room left. Returns the
   rows in pid order and whether a detail was dropped. *)
let add_details budget used chosen =
  let _, rows, dropped =
    List.fold_left
      (fun (used, rows, dropped) c ->
        if c.detail_size = 0 then (used, (c.pid, c.full) :: rows, dropped)
        else if used + c.detail_size <= budget then
          (used + c.detail_size, (c.pid, c.full) :: rows, dropped)
        else (used, (c.pid, c.base) :: rows, true))
      (used, [], false)
      (List.sort by_priority chosen)
  in
  (List.map snd (List.sort (fun (a, _) (b, _) -> compare a b) rows), dropped)

(* Rows that fit [budget] bytes, and whether they are the whole table with
   every detail. *)
let fit budget candidates =
  let chosen, used = choose_bare budget candidates in
  let rows, dropped = add_details budget used chosen in
  (rows, (not dropped) && List.compare_lengths chosen candidates = 0)

let host_json platform =
  match platform.process (Unix.getpid ()) with
  | Ok p ->
      `Assoc
        [
          ("pid", `Int p.pid);
          ("incarnation", `String (Int64.to_string p.incarnation));
        ]
  | Error _ -> `Null

let envelope platform ~complete rows extra =
  `Assoc
    ([
       ("version", `Int 1);
       ("host", host_json platform);
       ("complete", `Bool complete);
       ("processes", `List rows);
     ]
    @ extra)

let table platform budget =
  match platform.scan () with
  | Error _ -> envelope platform ~complete:false [] []
  | Ok { P.processes; skipped } ->
      let rows, whole = fit budget (List.map (candidate platform) processes) in
      envelope platform ~complete:(whole && skipped = 0) rows []

let selected platform pids =
  let found, errors =
    List.partition_map
      (fun pid ->
        match platform.process pid with
        | Ok p -> Left (`Assoc (base_fields p))
        | Error e ->
            Right
              (`Assoc [ ("pid", `Int pid); ("kind", `String (error_kind e)) ]))
      pids
  in
  envelope platform ~complete:true found [ ("errors", `List errors) ]

let default_budget = Mesh_wire.max_small_frame - 4096

let reply ?(platform = live) ?(budget = default_budget) = function
  | Table -> table platform budget
  | Selected pids -> selected platform pids
