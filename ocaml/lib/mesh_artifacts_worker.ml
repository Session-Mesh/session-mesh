(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)
module A = Mesh_session_artifacts

let run v =
  let op = A.string "op" 32 v in
  let root = Sys.getenv "MESH_CONF_DIR" in
  if op = "notes-call" then (
    A.exact [ "op"; "tool"; "arguments"; "session"; "nonce" ] v;
    let tool = A.string "tool" 32 v in
    if
      not
        (A.notes_authorized root (A.get "session" v) (A.string "nonce" 128 v)
           tool)
    then `Assoc [ ("status", `String "denied") ]
    else Mesh_notes_connector.execute tool (A.get "arguments" v))
  else
    let id = A.get "session" v in
    match op with
    | "notes-authorize" ->
        A.exact [ "op"; "session"; "nonce"; "tool" ] v;
        `Assoc
          [
            ( "allowed",
              `Bool
                (A.notes_authorized root id (A.string "nonce" 128 v)
                   (A.string "tool" 32 v)) );
          ]
    | "begin" ->
        A.exact [ "op" ] v;
        A.begin_observation root
    | "list" ->
        A.exact [ "op"; "session" ] v;
        A.catalogue root id
    | "observe" ->
        A.exact [ "op"; "session"; "reference"; "generation" ] v;
        let generation =
          match A.get "generation" v with `Int n -> n | _ -> A.fail ()
        in
        A.observe ~generation root id (A.get "reference" v)
    | "revoke" ->
        A.exact [ "op"; "session"; "id" ] v;
        A.revoke root id "notes" (A.string "id" 256 v)
    | "remove" ->
        A.exact [ "op"; "session" ] v;
        A.remove root id
    | "transfer" ->
        A.exact [ "op"; "session"; "target" ] v;
        A.transfer root id (A.get "target" v)
    | _ -> A.fail ()

let main () =
  try
    let input = input_line stdin in
    if String.length input > 1024 * 1024 then A.fail ();
    let result = run (Yojson.Safe.from_string input) in
    print_endline (Yojson.Safe.to_string result)
  with _ -> print_endline "{\"error\":\"artifacts-unavailable\"}"
