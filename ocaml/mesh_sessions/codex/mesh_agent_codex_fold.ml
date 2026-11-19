(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Py = Mesh_agent_py

type t = { last : string option; here : string option; said : string option }

let init = { last = None; here = None; said = None }
let strip = Mesh_python_text.unicode_strip

(* [_text_blocks]: the text blocks joined by spaces, stripped. *)
let text_blocks = function
  | `List blocks ->
      strip
        (String.concat " "
           (List.filter_map (fun block -> if Py.is_object block then Py.string (Py.get "text" block) else None) blocks))
  | _ -> ""

let is kind value = value = `String kind

(* [_codex_reply]: the agent's reply a line carries. *)
let reply kind payload =
  let sub = Py.get "type" payload in
  let text =
    if is "event_msg" kind && is "agent_message" sub then Py.string (Py.get "message" payload)
    else if is "event_msg" kind && is "item_completed" sub then
      let item = Py.get "item" payload in
      if Py.is_object item && is "AgentMessage" (Py.get "type" item) then Some (text_blocks (Py.get "content" item))
      else None
    else if is "event_msg" kind && is "task_complete" sub then Py.string (Py.get "last_agent_message" payload)
    else if is "response_item" kind && is "message" sub && is "assistant" (Py.get "role" payload) then
      Some (text_blocks (Py.get "content" payload))
    else None
  in
  match Option.map strip text with Some "" | None -> None | Some text -> Some (Mesh_python_text.clip text)

let prompt kind payload =
  if is "response_item" kind && is "message" (Py.get "type" payload) && is "user" (Py.get "role" payload) then
    match text_blocks (Py.get "content" payload) with
    | "" -> None
    | text when String.starts_with ~prefix:"<" text || String.starts_with ~prefix:"# AGENTS" text -> None
    | text -> Some (Mesh_python_text.clip text)
  else None

let turn_cwd kind payload =
  match Py.get "cwd" payload with `String cwd when is "turn_context" kind && cwd <> "" -> Some cwd | _ -> None

let step state line =
  match Py.get "payload" line with
  | `Assoc _ as payload when Py.is_object line ->
      let kind = Py.get "type" line in
      let pick fresh kept = match fresh with Some _ -> fresh | None -> kept in
      {
        said = pick (reply kind payload) state.said;
        here = pick (turn_cwd kind payload) state.here;
        last = pick (prompt kind payload) state.last;
      }
  | _ -> state

let fold : t Mesh_jsonl_tail.fold = { init = (fun () -> init); copy = Fun.id; step }
let text = function Some value -> `String value | None -> `Null
let last state = text state.last
let cwd state = text state.here
let said state = text state.said
