(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module View = Mesh_agent_codex_view
module Rollouts = Mesh_agent_codex_rollouts
module Checks = Mesh_session_checks

type source = Open_rollout | Argv_resume | Cwd_unique | Registry of Checks.registry_source
type t = { path : string option; id : Yojson.Safe.t; source : source; holds_open : bool }

type context = {
  view : View.t;
  rollouts : Rollouts.rollout list;
  describe_path : string -> Rollouts.rollout option;
  start_time : Mesh_agent_round.process -> float;
}

let source_name = function
  | Open_rollout -> "open_rollout"
  | Argv_resume -> "argv_resume"
  | Cwd_unique -> "cwd_unique"
  | Registry source -> Checks.registry_source_name source

let check_source = function
  | Open_rollout -> Checks.Open
  | Argv_resume -> Checks.Launch
  | Cwd_unique -> Checks.Guessed
  | Registry source -> Checks.Registry source

let folder = function Some here -> `String here | None -> `Null
let id_text = function `String id -> Some id | _ -> None
let top_level_in here (rollout : Rollouts.rollout) = rollout.header.cwd = folder here && not rollout.header.subagent

(* [_newest_top_level]: the most recently written, sub-agent rollouts skipped;
   equal times go to the first path. *)
let newest rollouts =
  let rollouts = List.sort_uniq (fun (a : Rollouts.rollout) b -> String.compare a.path b.path) rollouts in
  List.fold_left
    (fun best (rollout : Rollouts.rollout) ->
      match best with
      | _ when rollout.header.subagent -> best
      | Some (kept : Rollouts.rollout) when kept.mtime >= rollout.mtime -> best
      | _ -> Some rollout)
    None rollouts

let rollout_of context id = newest (List.filter (fun (r : Rollouts.rollout) -> r.header.id = `String id) context.rollouts)

let claimed context pid id =
  View.named_by_others context.view pid (Some id)
  ||
  match View.held_by_others context.view pid with
  | None -> true
  | Some held ->
      Hashtbl.fold
        (fun path () found ->
          found || match context.describe_path path with Some rollout -> rollout.header.id = `String id | None -> false)
        held false

(* [_later_conversation]: a newer top-level rollout of another id in the folder. *)
let later context process ~named ~(named_path : Rollouts.rollout option) =
  let pid = process.Mesh_platform.pid in
  let here = Mesh_agent_round.cwd (View.round context.view) pid and started = context.start_time process in
  let newer (rollout : Rollouts.rollout) =
    match named_path with Some named -> rollout.mtime > named.mtime | None -> true
  in
  let later =
    List.filter
      (fun (r : Rollouts.rollout) -> top_level_in here r && r.header.id <> `String named && r.mtime >= started && newer r)
      context.rollouts
  in
  later <> []
  &&
  match View.held_by_others context.view pid with
  | None -> true
  | Some held ->
      List.exists
        (fun (r : Rollouts.rollout) ->
          (not (Hashtbl.mem held r.path)) && not (View.named_by_others context.view pid (id_text r.header.id)))
        later

(* [_lone_codex_candidates], then the newest of them. *)
let guess context process =
  let pid = process.Mesh_platform.pid in
  let here = Mesh_agent_round.cwd (View.round context.view) pid and started = context.start_time process in
  let candidates = List.filter (fun (r : Rollouts.rollout) -> top_level_in here r && r.mtime >= started) context.rollouts in
  let candidates =
    if candidates = [] || View.count context.view here <> 1 then []
    else
      match View.held_by_others context.view pid with
      | None -> []
      | Some held -> List.filter (fun (r : Rollouts.rollout) -> not (Hashtbl.mem held r.path)) candidates
  in
  Option.map
    (fun (r : Rollouts.rollout) -> { path = Some r.path; id = r.header.id; source = Cwd_unique; holds_open = false })
    (newest candidates)

let launched context process named =
  if claimed context process.Mesh_platform.pid named then None
  else
    let named_path = rollout_of context named in
    if later context process ~named ~named_path then guess context process
    else
      Some
        {
          path = Option.map (fun (r : Rollouts.rollout) -> r.path) named_path;
          id = `String named;
          source = Argv_resume;
          holds_open = false;
        }

let registry context opened (id, source) =
  let holding = List.find_opt (fun (r : Rollouts.rollout) -> r.header.id = `String id) opened in
  let path = match holding with Some _ -> holding | None -> rollout_of context id in
  { path = Option.map (fun (r : Rollouts.rollout) -> r.path) path; id = `String id; source = Registry source; holds_open = holding <> None }

let conversation context ~registered process =
  let pid = process.Mesh_platform.pid in
  let opened = View.open_rollouts context.view pid in
  let opened_rollouts = List.filter_map context.describe_path (Option.value ~default:[] opened) in
  match (registered, opened) with
  | Some claim, _ -> Some (registry context opened_rollouts claim)
  | None, None -> None
  | None, Some _ -> (
      match newest opened_rollouts with
      | Some r -> Some { path = Some r.path; id = r.header.id; source = Open_rollout; holds_open = true }
      | None -> (
          match Mesh_agent_codex_argv.resumed_id (Mesh_agent_round.argv (View.round context.view) pid) with
          | Some named -> launched context process named
          | None -> guess context process))
