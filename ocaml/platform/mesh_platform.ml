(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type platform = Types.platform = Linux | Macos | Other of string

let platform =
  match System_name.value with
  | "macosx" -> Macos
  | value when String.starts_with ~prefix:"linux" value -> Linux
  | other -> Other other

let platform_name = function
  | Linux -> "linux"
  | Macos -> "macos"
  | Other name -> name

type capabilities = Types.capabilities = {
  process_table : bool;
  foreground_agent : bool;
  open_file_paths : bool;
  isolated_agent : bool;
  demo_sandbox : bool;
}

let capabilities = Backend.capabilities

type error = Types.error =
  | Unsupported of string
  | Not_found
  | Denied
  | Malformed of string

let error_to_string = function
  | Unsupported what -> "unsupported: " ^ what
  | Not_found -> "no such process"
  | Denied -> "permission denied"
  | Malformed what -> "malformed kernel data: " ^ what

type runtime_source = Types.runtime_source =
  | Xdg_runtime_dir
  | Mesh_runtime_dir
  | Run_user_guess
  | Macos_default

type runtime_dir = Types.runtime_dir = {
  path : string;
  source : runtime_source;
}

let max_socket_path = Runtime_dir.max_socket_path platform
let socket_path = Runtime_dir.socket_path

(* The passwd home of the effective user, not $HOME: see Runtime_dir. *)
let passwd_home () =
  match Unix.getpwuid (Unix.geteuid ()) with
  | entry -> Some entry.Unix.pw_dir
  | exception Not_found -> None

let runtime_dir ?(getenv = Sys.getenv_opt) ?(home = passwd_home)
    ?(run_user_root = "/run/user") () =
  Runtime_dir.resolve ~getenv ~home ~run_user_root ~platform
    ~euid:(Unix.geteuid ())

type process = Types.process = {
  pid : int;
  ppid : int;
  pgrp : int;
  sid : int;
  tpgid : int;
  comm : string;
  state : char;
  incarnation : int64;
}

type process_scan = Types.process_scan = {
  processes : process list;
  skipped : int;
}

let process = Backend.process
let scan = Backend.scan
let snapshot () = Result.map (fun found -> found.processes) (scan ())
let command_line = Backend.command_line
let working_directory = Backend.working_directory
let open_file_paths = Backend.open_file_paths
let process_owner = Backend.process_owner
let foreground_process_group = Backend.foreground_process_group
let unix_socket_bound = Backend.unix_socket_bound

module Parse = Parse
module Support = Support

type feature = Feature.t = Isolated_agent | Demo_sandbox

let feature_name = Feature.name
let feature_of_string = Feature.of_string

let require ?(capabilities = capabilities ()) feature =
  Feature.require ~platform ~platform_name ~capabilities feature

module For_testing = struct
  let require_on ~platform ~capabilities feature =
    Feature.require ~platform ~platform_name ~capabilities feature

  let unsupported_unix_socket_bound = Backend_unsupported.unix_socket_bound

  let runtime_dir_on ?(home = "/nonexistent/mesh-platform-home") ~platform
      ~getenv () =
    Runtime_dir.resolve ~getenv
      ~home:(fun () -> Some home)
      ~run_user_root:"/nonexistent/mesh-platform" ~platform
      ~euid:(Unix.geteuid ())
end
