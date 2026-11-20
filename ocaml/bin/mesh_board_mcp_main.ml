(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

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
        Mcp_kit_stdio.run_channels server stdin stdout
