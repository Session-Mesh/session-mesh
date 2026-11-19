(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Envelope = Mesh_jsonl_rpc_envelope

let schema = 1

let rpc_config =
  Mesh_jsonl_rpc.config ~max_request_bytes:(4 * 1024 * 1024) ~max_response_bytes:(8 * 1024 * 1024)
    ~max_depth:64 ~max_in_flight:4 ()

let bad_request message = Error { Envelope.code = Bad_request; message }

let hello registry =
  Ok
    [
      ("program", `String "mesh-sessions");
      ("schema", `Int schema);
      ("adapters", `List (List.map (fun kind -> `String kind) (Mesh_agent.Registry.kinds registry)));
    ]

let with_request (request : Envelope.request) answer =
  match Mesh_sessions_request.parse request.fields with
  | Ok parsed -> Ok (answer parsed)
  | Error message -> bad_request message

let handler engine registry : Mesh_jsonl_rpc.handler =
 fun request ~emit ->
  match request.op with
  | "hello" -> hello registry
  | "round" -> with_request request (fun parsed -> Mesh_sessions_round.round engine parsed ~emit)
  | "describe" -> with_request request (Mesh_sessions_round.describe engine)
  | other -> Error { Envelope.code = Unknown_op; message = "unknown operation " ^ Mesh_python_text.repr other }

let serve ~clock ?(config = Mesh_sessions_round.config ()) ~platform registry source sink =
  let engine = Mesh_sessions_round.create ~clock config platform registry in
  Mesh_jsonl_rpc.serve rpc_config (handler engine registry) source sink
