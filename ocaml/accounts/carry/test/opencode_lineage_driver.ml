(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

module T = Mesh_opencode_transfer

module R = Mesh_account_resolver
module C = Mesh_accounts_carry

let revision registry id =
  match R.find registry { backend = R.Opencode_v2; id } with
  | Ok entry -> Option.value ~default:"missing" (R.context_revision entry)
  | Error _ -> "missing"

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
  let uid = Unix.geteuid () in
  let file = Filename.concat (Filename.dirname source_root) "accounts.json" in
  let response =
    match R.load ~uid ~file with
    | Error error -> `Assoc [ ("ok", `Bool false); ("code", `String error.code) ]
    | Ok registry ->
        let source_revision =
          Option.value ~default:(revision registry source_profile)
            (Sys.getenv_opt "MESH_TEST_OPENCODE_SOURCE_REVISION")
        in
        (match C.carry_opencode_accounts ~uid ~file ~binary
                 ~home:(Filename.concat source_root "home") ~workspace
                 ~source_runtime:(Filename.concat source_root "runtime")
                 ~target_runtime:(Filename.concat target_root "runtime")
                 ~conversation:parent_native_id ~from_account:source_profile
                 ~to_account:target_profile ~source_revision
                 ~target_revision:(revision registry target_profile)
                 ~logical_id:"mesh-logical-proof" ~epoch ~receipt_directory
                 ~operation_id:("proof-epoch-" ^ string_of_int epoch) with
        | Ok lineage -> `Assoc [ ("ok", `Bool true); ("lineage", T.lineage_to_json lineage) ]
        | Error error -> `Assoc [ ("ok", `Bool false); ("code", `String error.code) ])
  in
  print_endline (Yojson.Safe.to_string response)
