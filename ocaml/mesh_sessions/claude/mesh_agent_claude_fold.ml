(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Py = Mesh_agent_py

let clip = Mesh_python_text.clip
let strip = Mesh_python_text.unicode_strip

type ask = { tool_id : string; choices : string list }

(* The tools of the latest assistant message: Python keeps their names to
   compare them with ["AskUserQuestion"]; their count (capped at 2) and
   whether the first is that tool answer the same question. *)
type tools = { count : int; first_is_ask : bool }

type t = {
  title : Yojson.Safe.t;
  last : string option;
  here : Yojson.Safe.t;
  said : string option;
  ask : ask option;
  ask_message : Yojson.Safe.t;
  tools : tools;
}

let no_tools = { count = 0; first_is_ask = false }

let init =
  {
    title = `Null;
    last = None;
    here = `Null;
    said = None;
    ask = None;
    ask_message = `Null;
    tools = no_tools;
  }

let non_blank text = match strip text with "" -> None | stripped -> Some stripped

(* What a value of a tool's input that Python prints with [str] becomes. *)
let tool_arguments = [ "command"; "file_path"; "path"; "pattern"; "url"; "query"; "description"; "prompt" ]

let first_question arguments =
  match Py.get "questions" arguments with
  | `List (question :: _) when Py.is_object question && Py.truthy (Py.get "question" question) ->
      Some (Py.get "question" question)
  | _ -> None

let tool_said block =
  let arguments = match Py.get "input" block with `Assoc _ as input -> input | _ -> `Assoc [] in
  match first_question arguments with
  | Some question -> Some ("\xe2\x9d\x93 " ^ Py.str question)
  | None ->
      let argument =
        List.find_map
          (fun key -> if Py.truthy (Py.get key arguments) then Some (Py.str (Py.get key arguments)) else None)
          tool_arguments
      in
      let name = Py.str (Py.first_truthy [ Py.get "name" block; `String "tool" ]) in
      let suffix = match argument with Some text when text <> "" -> " \xc2\xb7 " ^ text | _ -> "" in
      Some ("\xe2\x9a\x99 " ^ name ^ suffix)

(* [_claude_said]: what an assistant message ends with. *)
let said_of = function
  | `String text -> non_blank text
  | `List (_ :: _ as blocks) -> (
      let block = List.nth blocks (List.length blocks - 1) in
      match Py.get "type" block with
      | _ when not (Py.is_object block) -> None
      | `String "text" -> Option.bind (Py.string (Py.get "text" block)) non_blank
      | `String "tool_use" -> tool_said block
      | _ -> None)
  | _ -> None

let labels question =
  match Py.get "options" question with
  | `List options -> List.filter_map (fun option -> if Py.is_object option then Some (Py.get "label" option) else None) options
  | _ -> []

let usable_label = function `String text -> not (Mesh_python_text.is_blank text) | _ -> false

(* [_claude_choices]: one single-choice question that ends the message. *)
let choices_of block =
  let arguments = match Py.get "input" block with `Assoc _ as input -> input | _ -> `Assoc [] in
  match (Py.get "type" block, Py.get "name" block, Py.get "questions" arguments) with
  | `String "tool_use", `String "AskUserQuestion", `List [ question ] ->
      let question = if Py.is_object question then question else `Assoc [] in
      let labels = labels question in
      if Py.truthy (Py.get "multiSelect" question) || List.length labels < 2
         || not (List.for_all usable_label labels)
      then None
      else Some (List.filter_map Py.string labels |> List.map (clip ~max:40))
  | _ -> None

(* [_claude_ask]: the question's tool id and choices. *)
let ask_of = function
  | `List (_ :: _ as blocks) -> (
      let block = List.nth blocks (List.length blocks - 1) in
      if not (Py.is_object block) then None
      else
        match (choices_of block, Py.get "id" block) with
        | Some choices, `String tool_id when tool_id <> "" -> Some { tool_id; choices }
        | _ -> None)
  | _ -> None

let add_tool tools name =
  if tools.count = 0 then { count = 1; first_is_ask = name = `String "AskUserQuestion" }
  else { tools with count = 2 }

let message_tools content =
  match content with
  | `List blocks ->
      List.filter_map
        (fun block ->
          if Py.is_object block && Py.get "type" block = `String "tool_use" then Some (Py.get "name" block)
          else None)
        blocks
  | _ -> []

let assistant state message =
  let content = Py.get "content" message in
  let said = match said_of content with Some text -> Some (clip text) | None -> state.said in
  let identifier = Py.get "id" message in
  let state =
    if (not (Py.truthy identifier)) || identifier <> state.ask_message then
      { state with ask_message = identifier; tools = no_tools }
    else state
  in
  let tools = List.fold_left add_tool state.tools (message_tools content) in
  { state with said; tools; ask = ask_of content }

(* The text of a user message, or [None] when Python would not read it. *)
let prompt_text = function
  | `String text -> Some text
  | `List parts ->
      let texts =
        List.filter_map
          (fun part ->
            if Py.is_object part && Py.get "type" part = `String "text" then
              Some (match Py.get "text" part with `String text -> Some text | `Null -> Some "" | _ -> None)
            else None)
          parts
      in
      if List.mem None texts then None else Some (String.concat " " (List.filter_map Fun.id texts))
  | _ -> None

let is_prompt text =
  let start = Mesh_python_text.lstrip_index text in
  start < String.length text
  && text.[start] <> '<'
  && not (String.starts_with ~prefix:"This session is being continued" text)

let titles = [ "summary"; "custom-title"; "ai-title" ]

let title_or_prompt state line ~sidechain =
  match Py.get "type" line with
  | `String kind when List.mem kind titles ->
      let named = List.map (fun key -> Py.get key line) [ "customTitle"; "aiTitle"; "summary" ] in
      { state with title = Py.first_truthy (named @ [ state.title ]) }
  | `String "user" when (not (Py.truthy (Py.get "isMeta" line))) && (not sidechain) && Py.is_object (Py.get "message" line) -> (
      match prompt_text (Py.get "content" (Py.get "message" line)) with
      | Some text when is_prompt text -> { state with last = Some (clip text) }
      | _ -> state)
  | _ -> state

let step state line =
  if not (Py.is_object line) then state
  else
    let sidechain = Py.truthy (Py.get "isSidechain" line) in
    let state =
      match Py.get "type" line with
      | `String "assistant" when (not sidechain) && Py.is_object (Py.get "message" line) ->
          assistant state (Py.get "message" line)
      | `String "user" when not sidechain -> { state with ask = None }
      | _ -> state
    in
    let cwd = Py.get "cwd" line in
    let state = if (not sidechain) && Py.truthy cwd then { state with here = cwd } else state in
    title_or_prompt state line ~sidechain

let fold : t Mesh_jsonl_tail.fold = { init = (fun () -> init); copy = Fun.id; step }

let text = function Some value -> `String value | None -> `Null

let fields state =
  let ask = if state.tools = { count = 1; first_is_ask = true } then state.ask else None in
  [
    ("title", state.title);
    ("last", text state.last);
    ("cwd", state.here);
    ("said", text state.said);
    ("choices", match ask with Some ask -> `List (List.map (fun c -> `String c) ask.choices) | None -> `Null);
    ("ask_id", match ask with Some ask -> `String ask.tool_id | None -> `Null);
  ]
