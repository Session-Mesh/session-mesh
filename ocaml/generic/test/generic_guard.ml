(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let generic =
  [
    ("lru", "mesh_lru");
    ("priority", "mesh_priority");
    ("deadline_pool", "mesh_deadline_pool");
    ("jsonl", "mesh_jsonl");
    ("safe_file", "mesh_safe_file");
    ("jsonl_tail", "mesh_jsonl_tail");
    ("jsonl_rpc", "mesh_jsonl_rpc");
  ]

let external_allowed = [ "unix"; "threads.posix"; "yojson"; "eio"; "cstruct" ]
let ppx_allowed = []

let allowed_fields =
  [ "name"; "wrapped"; "modules"; "private_modules"; "libraries"; "preprocess"; "flags";
    "ocamlc_flags"; "ocamlopt_flags"; "synopsis" ]

(* A dune file as s-expressions. Block and datum comments are refused: they
   are the only syntax that could hide text from this reader. *)
type sexp = Atom of string | List of sexp list
type token = Open | Close | Word of string

let is_delimiter = function ' ' | '\n' | '\t' | '\r' | '(' | ')' | ';' | '"' -> true | _ -> false

let rec skip_line text index =
  if index >= String.length text || text.[index] = '\n' then index else skip_line text (index + 1)

let rec quoted_end text index =
  if index >= String.length text then failwith "unterminated string"
  else match text.[index] with '\\' -> quoted_end text (index + 2) | '"' -> index | _ -> quoted_end text (index + 1)

let rec atom_end text index =
  if index >= String.length text || is_delimiter text.[index] then index else atom_end text (index + 1)

let rec lex text index acc =
  if index >= String.length text then List.rev acc
  else
    match text.[index] with
    | ';' -> lex text (skip_line text index) acc
    | '(' -> lex text (index + 1) (Open :: acc)
    | ')' -> lex text (index + 1) (Close :: acc)
    | ' ' | '\n' | '\t' | '\r' -> lex text (index + 1) acc
    | '"' ->
        let stop = quoted_end text (index + 1) in
        lex text (stop + 1) (Word (String.sub text (index + 1) (stop - index - 1)) :: acc)
    | '#' when index + 1 < String.length text && (text.[index + 1] = '|' || text.[index + 1] = ';') ->
        failwith "block and datum comments (#| and #;) are not allowed"
    | _ ->
        let stop = atom_end text index in
        lex text stop (Word (String.sub text index (stop - index)) :: acc)

let rec items tokens acc =
  match tokens with
  | [] | Close :: _ -> (List.rev acc, tokens)
  | Word word :: rest -> items rest (Atom word :: acc)
  | Open :: rest -> (
      match items rest [] with
      | inner, Close :: rest -> items rest (List inner :: acc)
      | _ -> failwith "unbalanced parentheses")

let parse text =
  match items (lex text 0 []) [] with
  | sexps, [] -> sexps
  | _ -> failwith "unbalanced parentheses"

let rec atoms = function Atom atom -> [ atom ] | List sexps -> List.concat_map atoms sexps

(* Every library a (libraries ...) field may load, whatever the form ([select]
   alternatives, [re_export], a negated [!name]): all of its words except the
   keywords and file names. *)
let dependency_names args =
  let keyword word =
    List.mem word [ "select"; "from"; "re_export"; "->" ]
    || Filename.check_suffix word ".ml" || Filename.check_suffix word ".mli"
  in
  List.concat_map atoms args
  |> List.filter (fun word -> not (keyword word))
  |> List.map (fun word ->
         if String.length word > 1 && word.[0] = '!' then String.sub word 1 (String.length word - 1)
         else word)

let library_errors path name args =
  let allowed word = List.mem word external_allowed || List.exists (fun (_, lib) -> lib = word) generic in
  dependency_names args
  |> List.filter (fun word -> not (allowed word))
  |> List.map (fun word ->
         Printf.sprintf
           "%s: library %s may not depend on %s (allowed: the generic libraries and %s)" path name word
           (String.concat ", " external_allowed))

let rec preprocessors = function
  | [] | Atom "--" :: _ -> []
  | Atom word :: rest when String.length word > 0 && word.[0] = '-' -> preprocessors rest
  | Atom word :: rest -> word :: preprocessors rest
  | List _ :: rest -> "(...)" :: preprocessors rest

let preprocess_errors path args =
  match args with
  | [ Atom "no_preprocessing" ] -> []
  | [ List (Atom ("pps" | "staged_pps") :: words) ] ->
      preprocessors words
      |> List.filter (fun word -> not (List.mem word ppx_allowed))
      |> List.map (Printf.sprintf "%s: preprocessor %s is not allowed in a generic library" path)
  | _ -> [ path ^ ": this (preprocess ...) form is not allowed in a generic library" ]

let field_errors path name field args =
  match field with
  | "libraries" -> library_errors path name args
  | "preprocess" -> preprocess_errors path args
  | "flags" | "ocamlc_flags" | "ocamlopt_flags" when List.mem ":include" (List.concat_map atoms args) ->
      [ Printf.sprintf "%s: (%s (:include ...)) is not allowed in a generic library" path field ]
  | _ -> []

let fields_errors path name fields =
  let name_ok = List.exists (function List [ Atom "name"; Atom found ] -> found = name | _ -> false) fields in
  let missing = if name_ok then [] else [ Printf.sprintf "%s does not define library %s" path name ] in
  missing
  @ List.concat_map
      (function
        | List (Atom field :: args) when List.mem field allowed_fields -> field_errors path name field args
        | List (Atom field :: _) ->
            [ Printf.sprintf "%s: field (%s ...) is not allowed in a generic library" path field ]
        | _ -> [ path ^ ": malformed library field" ])
      fields

let stanza_head = function List (Atom head :: _) -> head | Atom atom -> atom | List _ -> "(...)"

let dune_errors path name =
  match parse (In_channel.with_open_bin path In_channel.input_all) with
  | [ List (Atom "library" :: fields) ] -> fields_errors path name fields
  | stanzas ->
      [ Printf.sprintf "%s: a generic directory holds exactly one (library ...) stanza, found: %s" path
          (String.concat ", " (List.map stanza_head stanzas)) ]
  | exception (Failure reason | Sys_error reason) -> [ Printf.sprintf "%s: %s" path reason ]

let is_directory path = try Sys.is_directory path with Sys_error _ -> false

(* Dune skips the directories whose name starts with '.' or '_' (and puts
   its object directories there in the build tree). *)
let source_directory path entry =
  entry <> "" && entry.[0] <> '.' && entry.[0] <> '_' && is_directory (Filename.concat path entry)

let nested_errors root directory =
  let path = Filename.concat root directory in
  if not (is_directory path) then [ Printf.sprintf "generic/%s is missing" directory ]
  else
    Sys.readdir path |> Array.to_list
    |> List.filter (source_directory path)
    |> List.map (fun entry ->
           Printf.sprintf "generic/%s/%s: nested directories are not allowed in generic/" directory entry)

let root_errors root known =
  Sys.readdir root |> Array.to_list
  |> List.concat_map (fun entry ->
         if entry = "dune" then [ "generic/dune: generic/ may not have a dune file of its own" ]
         else if source_directory root entry && not (List.mem entry known) then
           [ Printf.sprintf "generic/%s is not listed in generic_guard.ml" entry ]
         else [])

let check root =
  let known = "test" :: List.map fst generic in
  let errors =
    root_errors root known
    @ List.concat_map (nested_errors root) known
    @ List.concat_map
        (fun (directory, name) ->
          let path = Filename.concat (Filename.concat root directory) "dune" in
          if Sys.file_exists path then dune_errors path name else [ path ^ " is missing" ])
        generic
  in
  if errors = [] then Ok () else Error errors
