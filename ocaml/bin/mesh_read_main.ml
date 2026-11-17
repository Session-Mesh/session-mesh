(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let () =
  match Mesh_read.Config.from_env () with
  | Error message ->
      prerr_endline ("mesh-read: " ^ message);
      exit 78
  | Ok config ->
      Mcp_kit_stdio.run_channels (Mesh_read.server config) stdin stdout
