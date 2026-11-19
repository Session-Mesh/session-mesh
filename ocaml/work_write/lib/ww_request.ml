(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module E = Work_mcp.Work_err
module Q = Work_mcp.Work_questions
open E

type t = Answer of { question : string; text : string }

let max_bytes = 12288

(* Exactly these names, each once, and nothing else. *)
let exact names fields =
  let keys = List.map fst fields in
  List.length keys = List.length names && List.for_all (fun n -> List.mem n keys) names

let answer_args = function
  | `Assoc args when exact [ "question"; "text" ] args -> (
      match (List.assoc "question" args, List.assoc "text" args) with
      | `String question, `String text when Q.valid_id question -> Ok (Answer { question; text })
      | `String _, `String _ -> Error (invalid "question must be a question id: N- and 8 lowercase hex digits")
      | _ -> Error (invalid "question and text must be strings"))
  | _ -> Error (invalid "answer takes exactly the arguments question and text")

let parse text =
  match Yojson.Safe.from_string text with
  | exception Yojson.Json_error _ -> Error (invalid "the request is not JSON")
  | `Assoc fields when exact [ "op"; "args" ] fields -> (
      match List.assoc "op" fields with
      | `String "answer" -> answer_args (List.assoc "args" fields)
      | `String _ -> Error (invalid "unknown operation")
      | _ -> Error (invalid "op must be a string"))
  | `Assoc _ -> Error (invalid "the request holds exactly op and args, each once")
  | _ -> Error (invalid "the request must be a JSON object")
