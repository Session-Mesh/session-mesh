(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

module T = Mesh_opencode_transfer

let context root workspace =
  {
    T.home = Filename.concat root "home";
    config = Filename.concat root "config";
    data = Filename.concat root "data";
    state = Filename.concat root "state";
    cache = Filename.concat root "cache";
    runtime = Filename.concat root "runtime";
    location = workspace;
  }

let () =
  if Array.length Sys.argv <> 8 then (
    print_endline {|{"ok":false,"code":"invalid-arguments"}|};
    exit 2);
  let binary = Sys.argv.(1)
  and source_root = Sys.argv.(2)
  and target_root = Sys.argv.(3)
  and workspace = Sys.argv.(4)
  and receipt_directory = Sys.argv.(5)
  and parent_native_id = Sys.argv.(6)
  and epoch = int_of_string Sys.argv.(7) in
  let source_profile = Filename.basename source_root
  and target_profile = Filename.basename target_root in
  let response =
    match
      T.run_fork ~binary ~source:(context source_root workspace)
        ~target:(context target_root workspace) ~parent_native_id
        ~logical_id:"mesh-logical-proof" ~epoch ~source_profile ~target_profile
        ~receipt_directory ~operation_id:("proof-epoch-" ^ string_of_int epoch)
    with
    | Ok lineage ->
        `Assoc
          [
            ("ok", `Bool true);
            ("logical_id", `String lineage.logical_id);
            ("epoch", `Int lineage.epoch);
            ("parent_native_id", `String lineage.parent_native_id);
            ("native_id", `String lineage.native_id);
            ("messages", `Int lineage.messages);
          ]
    | Error code -> `Assoc [ ("ok", `Bool false); ("code", `String code) ]
  in
  print_endline (Yojson.Safe.to_string response)
