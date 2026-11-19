(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Round = Mesh_agent_round

type codex = {
  pid : int;
  top : bool;
  cwd : string option;
  words : string list;
  own : string list option;  (* [_open_rollouts]: unknown on any error *)
  held : string list option;  (* [_neighbour_rollouts]: none when gone or another user's *)
}

type t = { round : Round.t; complete : bool; codex : codex list; by_pid : (int, codex) Hashtbl.t }

let contains ~sub text =
  let length = String.length sub in
  let rec from index = index + length <= String.length text && (String.sub text index length = sub || from (index + 1)) in
  from 0

let is_rollout target = contains ~sub:"/.codex/sessions/" target && contains ~sub:"rollout-" target

let rollouts_of (opened : ((int * string) list, Mesh_platform.error) result) =
  Result.map (fun files -> List.filter is_rollout (List.map snd files)) opened

let is_codex (process : Round.process) = process.comm = "codex"

let top_level round (process : Round.process) =
  is_codex process && match Round.find round process.ppid with Some parent -> not (is_codex parent) | None -> true

(* [_neighbour_rollouts]: on Linux, a Codex that exited holds nothing, and so
   does one positively owned by another user; any other unreadable one (a
   non-dumpable process of this user is [Denied] too) holds unknown rollouts.
   Elsewhere every unreadable one is unknown. *)
let held round pid = function
  | Ok paths -> Some paths
  | Error _ when Mesh_platform.platform <> Mesh_platform.Linux -> None
  | Error Mesh_platform.Not_found -> Some []
  | Error _ -> ( match Round.owner round pid with Ok uid when uid <> Unix.getuid () -> Some [] | _ -> None)

let codex_of round (process : Round.process) =
  let top = top_level round process in
  let opened = rollouts_of (Round.open_files round process.pid) in
  {
    pid = process.pid;
    top;
    cwd = (if top then Round.cwd round process.pid else None);
    words = (if top then Round.argv round process.pid else []);
    own = Result.to_option opened;
    held = held round process.pid opened;
  }

let read round =
  let codex = List.map (codex_of round) (List.filter is_codex (Round.processes round)) in
  let by_pid = Hashtbl.create (List.length codex) in
  List.iter (fun entry -> Hashtbl.replace by_pid entry.pid entry) codex;
  { round; complete = Round.complete round; codex; by_pid }

let round view = view.round
let top_level view pid = match Hashtbl.find_opt view.by_pid pid with Some entry -> entry.top | None -> false

let open_rollouts view pid =
  match Hashtbl.find_opt view.by_pid pid with
  | Some entry -> entry.own
  | None -> Result.to_option (rollouts_of (Round.open_files view.round pid))

(* [_runs_in]: the same folder, or, outside Linux, a folder the platform did not report. *)
let runs_in here directory = here = directory || (here = None && Mesh_platform.platform <> Mesh_platform.Linux)

let count view directory =
  let count = List.length (List.filter (fun entry -> entry.top && runs_in entry.cwd directory) view.codex) in
  if view.complete then count else max count 2

(* [_descends_from]: [pid] is below [ancestor] in the table. *)
let descends view pid ~ancestor =
  let rec up pid seen =
    match Round.find view.round pid with
    | Some process when not (List.mem pid seen) -> process.ppid = ancestor || up process.ppid (pid :: seen)
    | _ -> false
  in
  up pid []

let held_by_others view pid =
  let table = Hashtbl.create 64 in
  let rec gather = function
    | [] -> Some table
    | entry :: rest when entry.pid = pid || descends view entry.pid ~ancestor:pid -> gather rest
    | { held = None; _ } :: _ -> None
    | { held = Some paths; _ } :: rest ->
        List.iter (fun path -> Hashtbl.replace table path ()) paths;
        gather rest
  in
  gather view.codex

let named_by_others view pid id =
  (not view.complete)
  || List.exists (fun entry -> entry.top && entry.pid <> pid && Mesh_agent_codex_argv.may_name entry.words id) view.codex
