(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

let run operation =
  ignore (Unix.umask 0o077);
  try
    let directory = Sys.getenv "MESH_CONF_DIR" in
    if Filename.is_relative directory then
      invalid_arg "relative configuration directory";
    let result =
      match operation with
      | "read" -> Mesh_flow.read directory
      | "write" ->
          let event = Yojson.Safe.from_channel stdin in
          Mesh_flow.write directory event;
          `Assoc [ ("ok", `Bool true) ]
      | _ -> invalid_arg "invalid operation"
    in
    Yojson.Safe.to_channel stdout result;
    output_char stdout '\n';
    flush stdout
  with _ ->
    prerr_endline "mesh-history: flow journal unavailable";
    exit 1
