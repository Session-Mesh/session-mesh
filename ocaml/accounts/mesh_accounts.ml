(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type account = {
  id : string;
  label : string;
  claude_config_dir : string option;
  codex_home : string option;
}

let max_bytes = 16 * 1024
let max_accounts = 16
let max_label = 24
let max_path = 1024

let valid_id id =
  let length = String.length id in
  length >= 1 && length <= 32 && id <> "default"
  && String.for_all
       (function 'a' .. 'z' | '0' .. '9' | '-' -> true | _ -> false)
       id

(* A code point that must not reach a label: C0 and C1 controls, DEL, and the
   bidirectional overrides and isolates that reorder the text around them. *)
let forbidden_code_point code =
  code < 0x20
  || (code >= 0x7f && code <= 0x9f)
  || (code >= 0x202a && code <= 0x202e)
  || (code >= 0x2066 && code <= 0x2069)

let valid_label label =
  let rec count index characters =
    if index >= String.length label then Some characters
    else
      let decoded = String.get_utf_8_uchar label index in
      let code = Uchar.to_int (Uchar.utf_decode_uchar decoded) in
      if (not (Uchar.utf_decode_is_valid decoded)) || forbidden_code_point code
      then None
      else count (index + Uchar.utf_decode_length decoded) (characters + 1)
  in
  match count 0 0 with
  | Some characters ->
      characters >= 1 && characters <= max_label && String.trim label <> ""
  | None -> false

let safe_path_character = function
  | 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '.' | '_' | '+' | '@' | '/' | '-' ->
      true
  | _ -> false

let valid_path path =
  let length = String.length path in
  length >= 2 && length <= max_path
  && path.[0] = '/'
  && path.[length - 1] <> '/'
  && String.for_all safe_path_character path
  &&
  match String.split_on_char '/' path with
  | "" :: components ->
      List.for_all
        (fun component ->
          component <> "" && component <> "." && component <> "..")
        components
  | _ -> false

let fields = [ "id"; "label"; "claude_config_dir"; "codex_home" ]

let optional_path name entries =
  match List.assoc_opt name entries with
  | None | Some `Null -> Ok None
  | Some (`String path) when valid_path path -> Ok (Some path)
  | Some _ ->
      Error
        (name
       ^ " must be an absolute, normalised path of A-Z a-z 0-9 . _ + @ / -")

let ( let* ) = Result.bind

let account_of = function
  | `Assoc entries ->
      let names = List.map fst entries in
      let* () =
        if
          List.for_all (fun name -> List.mem name fields) names
          && List.length (List.sort_uniq compare names) = List.length names
        then Ok ()
        else Error "an account has an unknown or repeated field"
      in
      let* id =
        match List.assoc_opt "id" entries with
        | Some (`String id) when valid_id id -> Ok id
        | _ ->
            Error "an account id must match [a-z0-9-]{1,32} and not be default"
      in
      let* label =
        match List.assoc_opt "label" entries with
        | Some (`String label) when valid_label label -> Ok label
        | _ ->
            Error
              (id
             ^ ": the label must be 1 to 24 characters, no control character")
      in
      let* claude_config_dir = optional_path "claude_config_dir" entries in
      let* codex_home = optional_path "codex_home" entries in
      if claude_config_dir = None && codex_home = None then
        Error (id ^ ": an account needs claude_config_dir or codex_home")
      else Ok { id; label; claude_config_dir; codex_home }
  | _ -> Error "an account must be an object"

let rec all_ok acc = function
  | [] -> Ok (List.rev acc)
  | value :: rest ->
      let* account = account_of value in
      all_ok (account :: acc) rest

let distinct values =
  List.length (List.sort_uniq compare values) = List.length values

let check_unique accounts =
  let folders =
    List.concat_map
      (fun account ->
        List.filter_map Fun.id [ account.claude_config_dir; account.codex_home ])
      accounts
  in
  if not (distinct (List.map (fun account -> account.id) accounts)) then
    Error "account ids must be unique"
  else if not (distinct folders) then Error "a folder is declared twice"
  else Ok accounts

let parse text =
  match Yojson.Safe.from_string text with
  | exception Yojson.Json_error _ -> Error "accounts.json is not JSON"
  | `Assoc [ ("v", `Int 1); ("accounts", `List values) ]
  | `Assoc [ ("accounts", `List values); ("v", `Int 1) ] ->
      if List.length values > max_accounts then
        Error "too many accounts (16 at most)"
      else
        let* accounts = all_ok [] values in
        check_unique accounts
  | _ -> Error "accounts.json must be exactly {\"v\": 1, \"accounts\": [...]}"

(* Every prefix of an absolute path, the root excluded: /a, /a/b, /a/b/c. *)
let prefixes path =
  let components = List.tl (String.split_on_char '/' path) in
  List.rev
    (snd
       (List.fold_left
          (fun (current, acc) component ->
            let next = current ^ "/" ^ component in
            (next, next :: acc))
          ("", []) components))

let lstat_opt path =
  match Unix.lstat path with
  | stats -> Ok (Some stats)
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok None
  | exception Unix.Unix_error (error, _, _) ->
      Error (path ^ ": " ^ Unix.error_message error)

(* No component is a symbolic link: a link could lead the agent's
   credentials anywhere, and the folder must be the one the operator wrote. *)
let no_link path =
  List.fold_left
    (fun result prefix ->
      let* () = result in
      match lstat_opt prefix with
      | Ok (Some { Unix.st_kind = Unix.S_LNK; _ }) ->
          Error (prefix ^ " is a symbolic link")
      | Ok _ -> Ok ()
      | Error message -> Error message)
    (Ok ()) (prefixes path)

let private_directory ~uid ~what path (stats : Unix.stats) =
  if stats.st_kind <> Unix.S_DIR then Error (path ^ " is not a directory")
  else if stats.st_uid <> uid then Error (path ^ " is not owned by the operator")
  else if stats.st_perm land what <> 0 then
    Error (path ^ " can be written by other users")
  else Ok ()

let check_directory ~uid path =
  let* () = if valid_path path then Ok () else Error "invalid path" in
  let* () = no_link path in
  let* found = lstat_opt path in
  match found with
  | Some stats -> private_directory ~uid ~what:0o022 path stats
  | None -> (
      let parent = Filename.dirname path in
      let* parent_stats = lstat_opt parent in
      match parent_stats with
      | None -> Error (parent ^ " does not exist")
      | Some stats -> private_directory ~uid ~what:0o002 parent stats)

let prepare_directory ~uid path =
  let* () = check_directory ~uid path in
  let* () =
    match Unix.mkdir path 0o700 with
    | () -> Ok ()
    | exception Unix.Unix_error (Unix.EEXIST, _, _) -> Ok ()
    | exception Unix.Unix_error (error, _, _) ->
        Error (path ^ ": " ^ Unix.error_message error)
  in
  let* found = lstat_opt path in
  match found with
  | Some stats -> private_directory ~uid ~what:0o022 path stats
  | None -> Error (path ^ " could not be created")

let read_file path =
  match
    Mesh_safe_file.with_regular path (fun descriptor stats ->
        if stats.Unix.st_size > max_bytes then
          Error "accounts.json is too large"
        else
          Ok (Mesh_safe_file.read_range descriptor ~offset:0 ~length:max_bytes))
  with
  | Ok result -> result
  | Error error -> Error ("accounts.json: " ^ Mesh_safe_file.error_message error)
  | exception Unix.Unix_error (error, _, _) ->
      Error ("accounts.json: " ^ Unix.error_message error)

let load ~uid path =
  let* text = read_file path in
  let* accounts = parse text in
  let* () =
    List.fold_left
      (fun result account ->
        let* () = result in
        List.fold_left
          (fun result folder ->
            let* () = result in
            Result.map_error
              (fun message -> account.id ^ ": " ^ message)
              (check_directory ~uid folder))
          (Ok ())
          (List.filter_map Fun.id
             [ account.claude_config_dir; account.codex_home ]))
      (Ok ()) accounts
  in
  Ok accounts

let to_json account =
  let optional name = function
    | None -> []
    | Some value -> [ (name, `String value) ]
  in
  `Assoc
    ([ ("id", `String account.id); ("label", `String account.label) ]
    @ optional "claude_config_dir" account.claude_config_dir
    @ optional "codex_home" account.codex_home)
