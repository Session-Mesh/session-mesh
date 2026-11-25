(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let () =
  Mcp_kit_trace_plugin.register (fun event ->
      let label =
        match event with
        | Mcp_kit.Trace.Started call -> "started " ^ call.method_
        | Finished (call, _) -> "finished " ^ call.method_
      in
      match Sys.getenv_opt "MESH_TEST_TRACE_OUTPUT" with
      | None -> ()
      | Some path ->
          let channel =
            open_out_gen [ Open_creat; Open_append; Open_text ] 0o600 path
          in
          Fun.protect
            ~finally:(fun () -> close_out channel)
            (fun () -> output_string channel (label ^ "\n")))
