(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let trace_observer () =
  match Sys.getenv_opt "MESH_MCP_TRACE_PLUGIN" with
  | None | Some "" -> (
      match Sys.getenv_opt "MESH_MCP_TRACE_JOURNAL" with
      | Some path when path <> "" -> Some (Mesh_trace_journal.observer ())
      | _ -> None)
  | Some path -> (
      match Mcp_kit_trace_plugin.load path with
      | Ok observer -> Some observer
      | Error error ->
          prerr_endline
            ("mesh-board-mcp: trace plugin unavailable: "
            ^ Mcp_kit_trace_plugin.error_message error);
          None)

let () =
  if Array.to_list Sys.argv = [ Sys.argv.(0); "--artifacts-worker" ] then
    Mesh_artifacts_worker.main ()
  else
    match Mesh_board_mcp.Config.from_env () with
    | Error message ->
        prerr_endline ("mesh-board-mcp: " ^ message);
        exit 78
    | Ok config ->
        let server =
          if Array.to_list Sys.argv = [ Sys.argv.(0); "--notes" ] then
            Mesh_board_mcp.notes_server config
          else Mesh_board_mcp.server config
        in
        let server =
          match trace_observer () with
          | Some observer -> Mcp_kit.Server.with_observer server observer
          | None -> server
        in
        Mcp_kit_stdio.run_channels server stdin stdout
