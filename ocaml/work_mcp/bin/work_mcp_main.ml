(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let () =
  Work_mcp.Work_identity.scrub_environment ();
  let server = Work_mcp.Work_server.server () in
  let server =
    match Sys.getenv_opt "MESH_MCP_TRACE_JOURNAL" with
    | Some path when path <> "" && not (Filename.is_relative path) ->
        Mcp_kit.Server.with_observer server (Mesh_trace_journal.observer_anonymous ())
    | _ -> server
  in
  Work_mcp.Work_stdio.run server stdin stdout
