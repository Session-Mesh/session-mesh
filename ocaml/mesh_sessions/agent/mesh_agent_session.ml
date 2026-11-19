(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Round = Mesh_agent_round

let agent_types = [ "claude"; "codex"; "pi"; "opencode"; "gemini"; "agy"; "vibe"; "copilot" ]

(* A process name that is not its agent's type: vibe execs its bundled TUI. *)
let process_agents = [ ("vibe-rs", "vibe") ]

let argv_text = Mesh_jsonl_value.drop_invalid_utf8
let name_text = Mesh_python_text.prefix ~code_points:max_int

let by_name name =
  if List.mem name agent_types then Some name else List.assoc_opt name process_agents

let basename path =
  match String.rindex_opt path '/' with
  | Some index -> String.sub path (index + 1) (String.length path - index - 1)
  | None -> path

let pi_scripts = [ "/pi-coding-agent/dist/cli.js"; "/pi-coding-agent/dist/bundle/cli.js" ]

(* The script a node process runs: its first word that is not an option. *)
let node_script words = List.find_opt (fun word -> not (String.starts_with ~prefix:"-" word)) words

let node_agent words =
  let is_pi =
    match words with
    | first :: _ -> List.exists (fun suffix -> String.ends_with ~suffix first) pi_scripts
    | [] -> false
  in
  let is_gemini =
    match node_script words with
    | Some script -> List.mem (basename script) [ "gemini"; "gemini.js" ]
    | None -> false
  in
  if is_pi then Some "pi" else if is_gemini then Some "gemini" else None

let of_argv argv =
  match List.map argv_text argv with
  | [] -> None
  | first :: rest -> (
      let base = basename first in
      match by_name base with
      | Some kind -> Some kind
      | None -> if List.mem base [ "node"; "nodejs" ] then node_agent rest else None)

let kind_of round (process : Round.process) =
  match by_name (name_text process.comm) with
  | Some kind -> Some kind
  | None -> of_argv (Round.argv round process.pid)

type frame = {
  leader : Round.process option;
  foreground : int;
  agent : (Round.process * string) option;
}

(* An agent whose parent, in the same session, is an agent too: a helper. *)
let nested round sid (process : Round.process) =
  match Round.find round process.ppid with
  | Some parent -> parent.sid = sid && kind_of round parent <> None
  | None -> false

let outermost_agent round sid tpgid =
  let candidates =
    Round.session round sid
    |> List.filter_map (fun (process : Round.process) ->
           match kind_of round process with
           | Some kind when not (nested round sid process) -> Some (process, kind)
           | _ -> None)
  in
  let key ((process : Round.process), _) = (process.pgrp <> tpgid, process.pid) in
  match List.stable_sort (fun a b -> compare (key a) (key b)) candidates with
  | first :: _ -> Some first
  | [] -> None

let frame round ~sid =
  let leader = Round.find round sid in
  let tpgid = match leader with Some process -> process.tpgid | None -> -1 in
  let foreground =
    match leader with
    | Some process when Round.find round process.tpgid <> None -> process.tpgid
    | _ -> sid
  in
  { leader; foreground; agent = outermost_agent round sid tpgid }

let agent_in_foreground frame =
  match (frame.leader, frame.agent) with
  | Some leader, Some ((agent : Round.process), _) -> agent.pgrp = leader.tpgid
  | _ -> false
