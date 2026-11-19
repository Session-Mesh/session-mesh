(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The generic libraries depend only on each other and on an allowed list of
   general-purpose packages: never on a session- or agent-specific library.
   This test reads the (libraries ...) field of every library stanza in the
   dune files of generic/ (its directory is given as the first argument) and
   fails on any other dependency, or on a generic directory it does not know.
   A new generic library is added to [generic]; a new external dependency to
   [external_allowed], deliberately. *)

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

let read_file path = In_channel.with_open_bin path In_channel.input_all

(* Atoms of a dune file, with comments removed: "(", ")" and words. *)
let tokens text =
  let buffer = Buffer.create 16 and out = ref [] in
  let flush () =
    if Buffer.length buffer > 0 then begin
      out := Buffer.contents buffer :: !out;
      Buffer.clear buffer
    end
  in
  let in_comment = ref false in
  String.iter
    (fun char ->
      if !in_comment then (if char = '\n' then in_comment := false)
      else
        match char with
        | ';' ->
            flush ();
            in_comment := true
        | '(' | ')' ->
            flush ();
            out := String.make 1 char :: !out
        | ' ' | '\n' | '\t' | '\r' -> flush ()
        | _ -> Buffer.add_char buffer char)
    text;
  flush ();
  List.rev !out

(* The words after each "(libraries" up to its ")". *)
let rec libraries = function
  | [] -> []
  | "(" :: "libraries" :: rest ->
      let rec take acc = function
        | ")" :: rest -> (List.rev acc, rest)
        | word :: rest -> take (word :: acc) rest
        | [] -> (List.rev acc, [])
      in
      let found, rest = take [] rest in
      found @ libraries rest
  | _ :: rest -> libraries rest

let rec names = function
  | [] -> []
  | "(" :: "name" :: name :: rest -> name :: names rest
  | _ :: rest -> names rest

let check_directory root (directory, expected_name) =
  let path = Filename.concat (Filename.concat root directory) "dune" in
  let words = tokens (read_file path) in
  if not (List.mem expected_name (names words)) then
    failwith (Printf.sprintf "%s does not define library %s" path expected_name);
  List.iter
    (fun library ->
      let allowed =
        List.mem library external_allowed || List.exists (fun (_, name) -> name = library) generic
      in
      if not allowed then
        failwith (Printf.sprintf "%s: generic library %s depends on %s" path expected_name library))
    (libraries words)

let () =
  let root = Sys.argv.(1) in
  let known = "test" :: List.map fst generic in
  Array.iter
    (fun entry ->
      if Sys.is_directory (Filename.concat root entry) && not (List.mem entry known) then
        failwith (Printf.sprintf "generic/%s is not listed in dependency_guard.ml" entry))
    (Sys.readdir root);
  List.iter (check_directory root) generic;
  print_endline "generic libraries: dependencies allowed"
