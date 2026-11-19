(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The contract every backend satisfies. It lives in an always-compiled module
   so [backend_check.ml] can check both backends against it on every build. *)

module type S = sig
  val process : int -> (Types.process, Types.error) result
  val scan : unit -> (Types.process_scan, Types.error) result
  val command_line : int -> (string list, Types.error) result
  val working_directory : int -> (string, Types.error) result
  val open_file_paths : int -> ((int * string) list, Types.error) result
  val process_owner : int -> (int, Types.error) result
  val foreground_process_group : int -> (int, Types.error) result
  val unix_socket_bound : string -> (bool, Types.error) result
  val capabilities : unit -> Types.capabilities
end
