(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let tool_name = "agent_guide_read"
let text = Mesh_agent_guide_text.text

let instructions =
  "You are running inside a session-mesh session: call " ^ tool_name
  ^ " once to read the guide to what you can do here (show files and panels to \
     the owner, whiteboard, demos, agent messages, session requests, the \
     account your session runs under and asking to change it, the work_* \
     project tracker)."

(* Pi declares direct MCP tools without the server instructions, and a
   client may defer the tool list: the description carries the same hint. *)
let description =
  "Read the session-mesh agent guide. You are running inside a session-mesh \
   session; this returns the guide to what you can do here beyond a plain \
   terminal: clickable paths, mesh-open panels, the whiteboard, demos, agent \
   messages, session requests and when to use the work_* project tracker. \
   Read-only, no arguments."

let tool =
  Mcp_kit.Tool.make ~description
    ~input_schema:(Mcp_kit.Schema.object_ ~additional_properties:false ())
    tool_name (function
    | `Assoc [] ->
        Ok
          {
            Mcp_kit.Tool.content = [ Mcp_kit.Tool.Text text ];
            is_error = false;
            structured_content = None;
          }
    | _ -> Error (tool_name ^ " takes no arguments"))
