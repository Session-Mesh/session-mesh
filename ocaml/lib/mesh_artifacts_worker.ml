(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)
module A = Mesh_session_artifacts

let prepare root v =
  A.exact [ "op"; "session"; "nonce"; "tool" ] v;
  let tool = A.string "tool" 32 v in
  let allowed =
    A.notes_authorized root (A.get "session" v) (A.string "nonce" 128 v) tool
  in
  if allowed && List.mem tool [ "mint_share"; "revoke_share" ] then
    try `Assoc (("allowed", `Bool true) :: A.fields (A.begin_observation root))
    with _ ->
      `Assoc [ ("allowed", `Bool true); ("status", `String "unavailable") ]
  else `Assoc [ ("allowed", `Bool allowed) ]

let record root v =
  A.exact [ "op"; "session"; "generation"; "outcome"; "attributed" ] v;
  let id = A.identity (A.get "session" v) and outcome = A.get "outcome" v in
  if A.get "status" outcome <> `String "success" then A.fail ();
  let observation = A.get "observation" outcome in
  let fields = List.remove_assoc "observation" (A.fields outcome) in
  try
    (* Confirmed revocation is account-wide even if its authorised source ended. *)
    let revoke =
      observation <> `Null && A.get "action" observation = `String "revoke"
    in
    if (not revoke) && A.get "attributed" v <> `Bool true then A.fail ();
    (match observation with
    | `Null -> ()
    | _ when revoke ->
        A.exact [ "action"; "id" ] observation;
        ignore (A.revoke root id "notes" (A.string "id" 256 observation))
    | _ ->
        A.exact [ "action"; "reference" ] observation;
        if A.get "action" observation <> `String "observe" then A.fail ();
        let generation =
          match A.get "generation" v with
          | `Int n when n >= 0 -> n
          | _ -> A.fail ()
        in
        ignore (A.observe ~generation root id (A.get "reference" observation)));
    `Assoc
      (( "catalogue",
         `String (if observation = `Null then "not-applicable" else "recorded")
       )
      :: fields)
  with _ ->
    `Assoc
      (("catalogue", `String "not-recorded")
      :: ( "warning",
           `String
             "Upstream succeeded; reference not recorded. Do not replay the \
              operation." )
      :: fields)

let run v =
  let op = A.string "op" 32 v in
  let root = Sys.getenv "MESH_CONF_DIR" in
  if op = "work-tools" then Mesh_work_tools.run root v
  else if op = "notes-call" then (
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
    | "notes-prepare" -> prepare root v
    | "notes-record" -> record root v
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
    | "restore-probe" ->
        A.exact [ "op"; "session" ] v;
        A.restore_probe root id
    | "restore-transfer" ->
        A.exact [ "op"; "session"; "target" ] v;
        A.restore_transfer root id (A.get "target" v)
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
