(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let () =
  match Mesh_board_mcp.Config.from_env () with
  | Error message ->
      prerr_endline ("mesh-board-mcp: " ^ message);
      exit 78
  | Ok config ->
      Mcp_kit_stdio.run_channels (Mesh_board_mcp.server config) stdin stdout
