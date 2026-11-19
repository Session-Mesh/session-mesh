(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Q = Work_mcp.Work_questions
module R = Work_mcp.Work_render

let max_questions = 50
let max_brief_questions = 20
let brief_text = 300

let shorten = function `String s -> `String (R.trunc_chars ~max:brief_text s) | v -> v

let brief_answer = function
  | `Assoc fields -> `Assoc (List.map (fun (k, v) -> if k = "text" then (k, shorten v) else (k, v)) fields)
  | v -> v

(* The question of a summary view: text, assumption and answers cut at
   [brief_text] characters; the [task] view has them in full. *)
let brief = function
  | `Assoc fields ->
      `Assoc
        (List.map
           (fun (k, v) ->
             match (k, v) with
             | ("text" | "assumption"), v -> (k, shorten v)
             | "answers", `List answers -> (k, `List (List.map brief_answer answers))
             | _ -> (k, v))
           fields)
  | v -> v

(* Open questions first, then answered ones, each group newest first: an old
   unanswered question is never pushed out by newer answered ones. *)
let ordered questions =
  let newest = List.rev questions in
  List.filter Q.is_open newest @ List.filter (fun q -> not (Q.is_open q)) newest

let to_json ~brief:short q = if short then brief (R.question_json q) else R.question_json q

let fields ?(brief = false) ~about questions =
  let mine = List.filter (fun (q : Q.question) -> match q.about with Some a -> List.mem a about | None -> false) questions in
  let open_count = List.length (List.filter Q.is_open mine) in
  let cap = if brief then max_brief_questions else max_questions in
  ("open_questions", `Int open_count) :: Wr_out.list "questions" cap (List.map (to_json ~brief) (ordered mine))
