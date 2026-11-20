(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module E = Work_mcp.Work_err
module Q = Work_mcp.Work_questions
open E

type t = Answer of { question : string; text : string; edit : bool; choices : string list }

let max_bytes = 16384

(* Exactly these names, each once, and nothing else. *)
let exact names fields =
  let keys = List.map fst fields in
  List.length keys = List.length names && List.for_all (fun n -> List.mem n keys) names

(* Every [required] name, any of [optional], each once, and nothing else. *)
let within ~required ~optional fields =
  let keys = List.map fst fields in
  List.length (List.sort_uniq compare keys) = List.length keys
  && List.for_all (fun n -> List.mem n keys) required
  && List.for_all (fun k -> List.mem k required || List.mem k optional) keys

let edit_arg args =
  match List.assoc_opt "edit" args with
  | None -> Ok false
  | Some (`Bool b) -> Ok b
  | Some _ -> Error (invalid "edit must be a boolean")

(* The checks against the question (an option of it, once, how many) are
   made by the library, under the lock. *)
let choices_arg args =
  match List.assoc_opt "choices" args with
  | None -> Ok []
  | Some (`List l) when List.length l <= Q.max_options ->
      if List.for_all (function `String _ -> true | _ -> false) l then
        Ok (List.map (function `String s -> s | _ -> "") l)
      else Error (invalid "choices must be strings")
  | Some (`List _) -> Error (invalid "at most %d choices" Q.max_options)
  | Some _ -> Error (invalid "choices must be a list of strings")

let answer_args = function
  | `Assoc args when within ~required:[ "question"; "text" ] ~optional:[ "edit"; "choices" ] args -> (
      match (List.assoc "question" args, List.assoc "text" args) with
      | `String question, `String text when Q.valid_id question ->
          let* edit = edit_arg args in
          let* choices = choices_arg args in
          Ok (Answer { question; text; edit; choices })
      | `String _, `String _ -> Error (invalid "question must be a question id: N- and 8 lowercase hex digits")
      | _ -> Error (invalid "question and text must be strings"))
  | _ -> Error (invalid "answer takes the arguments question and text, and optionally edit and choices, each once")

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
