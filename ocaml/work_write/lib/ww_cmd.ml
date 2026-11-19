(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module W = Mesh_worklog
module E = Work_mcp.Work_err
module Q = Work_mcp.Work_questions
open E

let schema_version = 1

let session_variables =
  [
    "MESH_SESSION";
    "MESH_SESSION_TOKEN";
    "WL_SESSION";
    "WL_AGENT";
    "CLAUDE_CODE_SESSION_ID";
    "OPENCODE_SESSION_ID";
    "CODEX_THREAD_ID";
  ]

let outside_agent_session getenv =
  let set name = match getenv name with Some v -> v <> "" | None -> false in
  if List.exists set session_variables then
    Error
      (E.make "agent_session"
         "work-write runs only for the web server's signed-in owner, not in an agent session; \
          agents relay the owner's words with work_answer")
  else Ok ()

let answered qid ~duplicate =
  `Assoc
    [
      ("schema", `Int schema_version);
      ("command", `String "answer");
      ("id", `String qid);
      ("state", `String "answered");
      ("owner_verified", `Bool true);
      ("duplicate", `Bool duplicate);
    ]

let outcome = function
  | Q.Recorded qid -> Ok (answered qid ~duplicate:false)
  | Q.Same_answer qid -> Ok (answered qid ~duplicate:true)
  | Q.Already_answered qid ->
      Error (E.make "already_answered" (Printf.sprintf "question %s already has another answer from the owner" qid))

let run ?(getenv = Sys.getenv_opt) (Ww_request.Answer { question; text }) =
  let* ctx = Result.map_error of_worklog (W.Ctx.of_env ~getenv ~warn:ignore ()) in
  let* recorded = lift (Q.answer_once ctx ~owner_web:true ~question ~text ~by:Q.owner_by ()) in
  outcome recorded

let exit_code (e : E.t) =
  match e.code with
  | "already_answered" -> 8
  | "agent_session" -> 9
  | _ -> Work_read.Wr_out.exit_code e

let of_request () =
  let* () = outside_agent_session Sys.getenv_opt in
  let* text = Work_read.Wr_request.read ~max_bytes:Ww_request.max_bytes stdin in
  let* request = Ww_request.parse text in
  run request

let print json =
  print_string (Yojson.Safe.to_string json);
  print_char '\n'

(* Every exception becomes an [internal] error (exit 7): an uncaught one would
   make the runtime exit with 2, the code of [invalid_input]. *)
let main args =
  let result =
    try
      match args with
      | [ "--request" ] -> of_request ()
      | _ -> Error (invalid "usage: work-write --request (the request on standard input)")
    with _ -> Error (E.internal "unexpected exception")
  in
  try
    match result with
    | Ok json ->
        print json;
        0
    | Error e ->
        print (Work_read.Wr_out.error_document e);
        exit_code e
  with _ -> 7
