(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let () =
  match Array.to_list Sys.argv with
  | [ _ ] -> Mesh_ptyhost.run ()
  | [ _; "--private-preset-directory"; directory ] ->
      Mesh_ptyhost.run ~private_preset_directory:directory ()
  | [ _; "--agent-preset-config"; path; expected_sha256 ] ->
      Mesh_ptyhost.run ~agent_preset_config:(path, expected_sha256) ()
  | [
   _;
   "--private-preset-directory";
   directory;
   "--agent-preset-config";
   path;
   expected_sha256;
  ] ->
      Mesh_ptyhost.run ~private_preset_directory:directory
        ~agent_preset_config:(path, expected_sha256) ()
  | _ -> invalid_arg "host startup arguments"
