(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let () =
  Work_mcp.Work_identity.scrub_environment ();
  Work_mcp.Work_stdio.run (Work_mcp.Work_server.server ()) stdin stdout
