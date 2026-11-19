(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* mesh-sessions: describes the sessions the web server lists, over
   stdin/stdout in JSON lines (docs/sessions-protocol.md). Read-only. *)

let adapters roots =
  [ Mesh_agent.adapter (module Mesh_agent_claude) roots; Mesh_agent.adapter (module Mesh_agent_codex) roots ]

let () =
  ignore (Unix.umask 0o077);
  Sys.set_signal Sys.sigpipe Sys.Signal_ignore;
  match Mesh_agent_roots.of_environment Sys.getenv_opt with
  | Error message ->
      prerr_endline ("mesh-sessions: " ^ message);
      exit 78
  | Ok roots -> (
      let registry = Mesh_agent.Registry.create (adapters roots) in
      try
        Eio_main.run (fun env ->
            Mesh_sessions_server.serve ~clock:(Eio.Stdenv.clock env) ~platform:Mesh_pty_processes.live
              registry (Eio.Stdenv.stdin env) (Eio.Stdenv.stdout env))
      with _ ->
        (* The reason may name a path: the web server sees the exit status. *)
        prerr_endline "mesh-sessions: stopped on an unexpected failure";
        exit 70)
