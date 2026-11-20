(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Q = Work_mcp.Work_questions
module E = Work_mcp.Work_err
open E

let default_limit = 20
let max_limit = 100

(* The questions asked after [after] (in time order), or all of them. The
   cursor is any question of the tracker, open or answered since, so a page
   read after an answer still goes on where the previous one stopped. *)
let after_cursor (questions : Q.question list) = function
  | None -> Ok questions
  | Some id ->
      let rec drop = function
        | [] -> Error (not_found "no question %s" id)
        | (q : Q.question) :: rest -> if q.id = id then Ok rest else drop rest
      in
      drop questions

let run (loaded : Wr_load.t) ~after ~limit =
  let* later = after_cursor loaded.questions after in
  let page = List.filter Q.is_open later in
  Ok
    (Wr_out.document "open-questions"
       ([ ("open_questions", `Int (List.length (List.filter Q.is_open loaded.questions))) ]
       @ Wr_out.list "questions" limit
           (List.map (fun q -> Wr_question_context.add loaded q (Wr_questions.to_json ~brief:false q)) page)
       @ Wr_load.warnings_json loaded))
