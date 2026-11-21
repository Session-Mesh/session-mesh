(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module E = Work_mcp.Work_err
open E

let dispatch loaded = function
  | Wr_args.Products -> Wr_products.run loaded
  | Wr_args.Projects { product; all } -> Wr_projects.list loaded ~product ~all
  | Wr_args.Project_detail id -> Wr_projects.detail loaded id
  | Wr_args.Product_detail id -> Wr_product.run loaded id
  | Wr_args.Task_detail id -> Wr_task.run loaded id
  | Wr_args.Resume { product; project; all } -> Wr_resume.run loaded ~product ~project ~all
  | Wr_args.Sessions_of target -> Wr_sessions.run loaded target
  | Wr_args.Session_questions -> Wr_session_questions.run loaded
  | Wr_args.Ids -> Wr_ids.run loaded
  | Wr_args.Open_questions { after; limit } -> Wr_open_questions.run loaded ~after ~limit

let run ?getenv args =
  Wr_out.reset ();
  let* command = Wr_args.parse args in
  let* loaded = Wr_load.load ?getenv () in
  dispatch loaded command

let of_request () =
  let* text = Wr_request.read stdin in
  Wr_request.parse text

(* Every exception, whatever it is, becomes an [internal] error (exit 7): an
   uncaught one would make the runtime exit with 2, the code of
   [invalid_input]. *)
let document args =
  let result =
    try
      match args with
      | [ "--request" ] -> Result.bind (of_request ()) (fun words -> run words)
      | args -> run args
    with _ -> Error (E.internal "unexpected exception")
  in
  try Wr_out.finish result with _ -> 7

(* [context] is the agent hook (Wr_context): its own output, always exit 0.
   It is reachable from the command line only, never through [--request]. *)
let main = function "context" :: rest -> Wr_context.main rest | args -> document args
