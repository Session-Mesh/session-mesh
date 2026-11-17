(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Types shared by the backends, the parsers and the public interface. The
   public module re-exports them with equal definitions. *)

type platform = Linux | Macos | Other of string

type capabilities = {
  process_table : bool;
  foreground_agent : bool;
  open_file_paths : bool;
  isolated_agent : bool;
  demo_sandbox : bool;
}

type error = Unsupported of string | Not_found | Denied | Malformed of string

type runtime_source =
  | Xdg_runtime_dir
  | Mesh_runtime_dir
  | Run_user_guess
  | Macos_default

type runtime_dir = { path : string; source : runtime_source }

type process = {
  pid : int;
  ppid : int;
  pgrp : int;
  sid : int;
  tpgid : int;
  comm : string;
  state : char;
  incarnation : int64;
}

type process_scan = { processes : process list; skipped : int }
