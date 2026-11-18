(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type getenv = string -> string option

let python_repr = Mesh_python_text.repr

(* pathlib drops empty and "." components: "/a//b/./c/" is "/a/b/c". *)
let normalise absolute =
  String.split_on_char '/' absolute
  |> List.filter (fun part -> part <> "" && part <> ".")
  |> String.concat "/" |> ( ^ ) "/"

let home getenv =
  match getenv "HOME" with
  | Some home when home <> "" -> Ok home
  | Some _ | None -> (
      match Unix.getpwuid (Unix.getuid ()) with
      | entry -> Ok entry.Unix.pw_dir
      | exception Not_found ->
          Error "session-mesh: the home directory cannot be determined")

let directory getenv variable default =
  match getenv variable with
  | Some value when value <> "" ->
      if String.length value > 0 && value.[0] = '/' then Ok (normalise value)
      else
        Error
          (Printf.sprintf "session-mesh: %s must be an absolute path (got %s)"
             variable (python_repr value))
  | Some _ | None ->
      Result.bind (home getenv) (fun home ->
          let path = Filename.concat home default in
          if String.length path > 0 && path.[0] = '/' then Ok (normalise path)
          else Ok path)

let conf_dir getenv =
  directory getenv "MESH_CONF_DIR" (Filename.concat ".config" "session-mesh")

let cache_dir getenv =
  directory getenv "MESH_CACHE_DIR" (Filename.concat ".cache" "session-mesh")

type port = int

let port_number port = port
let is_ascii_digit = function '0' .. '9' -> true | _ -> false

let port getenv =
  let value =
    match getenv "MESH_PORT" with
    | Some value when value <> "" -> value
    | Some _ | None -> "7690"
  in
  let digits =
    String.length value <= 5 && String.for_all is_ascii_digit value
  in
  (* Five ASCII digits at most: int_of_string cannot fail or overflow. *)
  if digits && int_of_string value >= 1 && int_of_string value <= 65535 then
    Ok (int_of_string value)
  else
    Error
      (Printf.sprintf
         "session-mesh: MESH_PORT must be a port number between 1 and 65535 \
          (got %s)"
         (python_repr value))
