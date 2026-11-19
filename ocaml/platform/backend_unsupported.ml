(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Backend for every system without an inspection implementation: inspection
   is refused with [Unsupported], capabilities are all false. *)

open Types

let unsupported what =
  Error (Unsupported (what ^ " is not implemented on this build"))

let process _pid = unsupported "process inspection"
let scan () = unsupported "process table"
let command_line _pid = unsupported "command line inspection"
let working_directory _pid = unsupported "working directory inspection"
let open_file_paths _pid = unsupported "open file inspection"
let process_owner _pid = unsupported "process owner inspection"
let foreground_process_group _pid = unsupported "foreground process group"
let unix_socket_bound _path = unsupported "Unix socket inspection"

let capabilities () =
  {
    process_table = false;
    foreground_agent = false;
    open_file_paths = false;
    isolated_agent = false;
    demo_sandbox = false;
  }
