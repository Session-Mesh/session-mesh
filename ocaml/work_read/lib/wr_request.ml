(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module E = Work_mcp.Work_err
open E

let max_bytes = 4096

let ops =
  [
    "attachment-context";
    "products";
    "projects";
    "product";
    "project";
    "task";
    "resume";
    "sessions-of";
    "session-questions";
    "ids";
    "open-questions";
  ]

let read ?(max_bytes = max_bytes) channel =
  let buffer = Buffer.create 512 and chunk = Bytes.create 1024 in
  let rec go () =
    if Buffer.length buffer > max_bytes then
      Error (invalid "the request is longer than %d bytes" max_bytes)
    else
      match input channel chunk 0 (Bytes.length chunk) with
      | 0 -> Ok (Buffer.contents buffer)
      | n ->
          Buffer.add_subbytes buffer chunk 0 n;
          go ()
  in
  go ()

(* One argument as words of the command line; [Wr_args.parse] then applies
   the strict checks (names allowed per subcommand, values, identifiers). *)
let words op = function
  | "id", `String v
    when (op = "product" || op = "project" || op = "task")
         && not (String.length v > 0 && v.[0] = '-') ->
      Ok [ v ]
  | "id", _ ->
      Error (invalid "id is one identifier, for product, project and task only")
  | "all", `Bool true -> Ok [ "--all" ]
  | "all", _ -> Error (invalid "all must be true")
  | "limit", `Int n when op = "open-questions" ->
      Ok [ "--limit"; string_of_int n ]
  | name, `String v -> Ok [ "--" ^ name; v ]
  | name, _ ->
      Error
        (invalid "argument %s must be a string"
           (Work_mcp.Work_text.clean (String.escaped name)))

let argv op args =
  let names = List.map fst args in
  if List.length (List.sort_uniq compare names) <> List.length names then
    Error (invalid "an argument is repeated")
  else
    List.fold_left
      (fun acc arg ->
        let* acc = acc in
        let* more = words op arg in
        Ok (acc @ more))
      (Ok [ op ]) args

let parse text =
  match Yojson.Safe.from_string text with
  | exception Yojson.Json_error _ -> Error (invalid "the request is not JSON")
  | `Assoc fields -> (
      let named key =
        List.length (List.filter (fun (k, _) -> k = key) fields)
      in
      if
        List.exists (fun (k, _) -> k <> "op" && k <> "args") fields
        || named "op" > 1
        || named "args" > 1
      then Error (invalid "the request holds an unknown or repeated field")
      else
        match (List.assoc_opt "op" fields, List.assoc_opt "args" fields) with
        | Some (`String op), (None | Some (`Assoc _)) when List.mem op ops ->
            let args =
              match List.assoc_opt "args" fields with
              | Some (`Assoc a) -> a
              | _ -> []
            in
            argv op args
        | Some (`String _), (None | Some (`Assoc _)) ->
            Error (invalid "unknown operation")
        | _ -> Error (invalid "the request needs an op and an object of args"))
  | _ -> Error (invalid "the request must be a JSON object")
