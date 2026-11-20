(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let tools =
  Work_tools_read.tools @ Work_tools_write.tools @ Work_tools_sessions.tools @ Work_tools_questions.tools
  @ Work_tools_attempts.tools

let server () =
  let server =
    Mcp_kit.Server.create ~name:"work-mcp" ~version:"0.1.0" ~instructions:Work_instructions.text ()
  in
  match Mcp_kit.Server.add_tools server tools with
  | Ok server -> server
  | Error (Mcp_kit.Server.Duplicate_tool name) -> failwith ("duplicate tool: " ^ name)
  | Error _ -> failwith "invalid work-mcp declaration"
