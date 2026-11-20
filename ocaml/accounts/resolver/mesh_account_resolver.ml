(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type backend = Claude | Codex

let backend_of_string = function
  | "claude" -> Some Claude
  | "codex" -> Some Codex
  | _ -> None

let backend_to_string = function Claude -> "claude" | Codex -> "codex"

(* The variable an agent reads its folder from, the folder's name under $HOME
   for the default account, and the agent's name in messages. *)
let agent_names = function
  | Claude -> ("CLAUDE_CONFIG_DIR", ".claude", "Claude")
  | Codex -> ("CODEX_HOME", ".codex", "Codex")

type account_ref = { backend : backend; id : string }

(* [folder] is None for the default account only. *)
type entry = {
  backend : backend;
  id : string;
  label : string;
  folder : string option;
}

type t = { aliases : Mesh_accounts.account list; entries : entry list }
type error = { code : string; message : string }

let default_id = "default"
let default_label = "Default account"
let fail code message = Error { code; message }
let refused message = fail "accounts_refused" message
let ( let* ) = Result.bind

let default_entry backend =
  { backend; id = default_id; label = default_label; folder = None }

let entries_of (alias : Mesh_accounts.account) =
  let entry backend = function
    | None -> []
    | Some folder ->
        [ { backend; id = alias.id; label = alias.label; folder = Some folder } ]
  in
  entry Claude alias.claude_config_dir @ entry Codex alias.codex_home

let distinct values =
  List.length (List.sort_uniq compare values) = List.length values

(* The guarantees the web server relies on, checked again here so that they
   hold whatever the source: the server writes folders on a shell line. *)
let check_alias (alias : Mesh_accounts.account) =
  let folders =
    List.filter_map Fun.id [ alias.claude_config_dir; alias.codex_home ]
  in
  if not (Mesh_accounts.valid_id alias.id) then
    refused "an account id must match [a-z0-9-]{1,32} and not be default"
  else if not (Mesh_accounts.valid_label alias.label) then
    refused (alias.id ^ ": the label must be 1 to 24 characters")
  else if folders = [] then
    refused (alias.id ^ ": an account needs claude_config_dir or codex_home")
  else if not (List.for_all Mesh_accounts.valid_path folders) then
    refused (alias.id ^ ": a folder is not an absolute, shell-safe path")
  else Ok ()

let check_backend entries backend =
  let mine = List.filter (fun (e : entry) -> e.backend = backend) entries in
  if not (distinct (List.map (fun (e : entry) -> e.id) mine)) then
    refused "account ids must be unique"
  else if
    not
      (distinct
         (List.map (fun (e : entry) -> String.lowercase_ascii e.label) mine))
  then refused "account labels must be unique"
  else Ok ()

let of_accounts aliases =
  let* () =
    List.fold_left
      (fun result alias ->
        let* () = result in
        check_alias alias)
      (Ok ()) aliases
  in
  let entries = List.concat_map entries_of aliases in
  let* () = check_backend entries Claude in
  let* () = check_backend entries Codex in
  Ok { aliases; entries }

let load ~uid ~file =
  match Mesh_accounts.load ~uid file with
  | Error message -> refused message
  | Ok aliases -> of_accounts aliases

let list t = t.entries

let find t ({ backend; id } : account_ref) =
  if id = default_id then Ok (default_entry backend)
  else
    match
      List.find_opt
        (fun (e : entry) -> e.backend = backend && e.id = id)
        t.entries
    with
    | Some entry -> Ok entry
    | None -> (
        match List.find_opt (fun (e : entry) -> e.id = id) t.entries with
        | Some other ->
            let _, _, shown = agent_names backend in
            fail "account_no_agent"
              (Printf.sprintf "account %s has no %s folder" other.id shown)
        | None -> fail "account_unknown" "unknown account")

let candidates_message entries =
  "several accounts match: "
  ^ String.concat ", "
      (List.map (fun (e : entry) -> Printf.sprintf "%s (%s)" e.id e.label) entries)

(* The accounts of [backend], default first. *)
let accounts_of t backend =
  default_entry backend
  :: List.filter (fun (e : entry) -> e.backend = backend) t.entries

let label_matches t backend name =
  let wanted = String.lowercase_ascii name in
  List.filter
    (fun (e : entry) -> String.lowercase_ascii e.label = wanted)
    (accounts_of t backend)

let resolve_name t backend name =
  match List.find_opt (fun (e : entry) -> e.id = name) (accounts_of t backend) with
  | Some entry -> Ok entry
  | None -> (
      match label_matches t backend name with
      | [ entry ] -> Ok entry
      | [] -> find t ({ backend; id = name } : account_ref)
      | several -> fail "account_ambiguous" (candidates_message several))

let serves t ~id backend = Result.is_ok (find t ({ backend; id } : account_ref))
let ref_ (entry : entry) : account_ref = { backend = entry.backend; id = entry.id }
let label (entry : entry) = entry.label

let launch_env (entry : entry) =
  match entry.folder with
  | None -> []
  | Some folder ->
      let variable, _, _ = agent_names entry.backend in
      [ (variable, folder) ]

let folder_refused message = fail "account_folder_refused" message

let prepare ~uid (entry : entry) =
  match entry.folder with
  | None -> Ok entry
  | Some folder -> (
      match Mesh_accounts.prepare_directory ~uid folder with
      | Ok () -> Ok entry
      | Error message -> folder_refused message)

let prepare_id ~uid t id =
  match
    List.find_opt (fun (a : Mesh_accounts.account) -> a.id = id) t.aliases
  with
  | None -> fail "account_unknown" "unknown account"
  | Some alias ->
      let* () =
        List.fold_left
          (fun result (entry : entry) ->
            let* () = result in
            if entry.id = id then Result.map ignore (prepare ~uid entry)
            else Ok ())
          (Ok ()) t.entries
      in
      Ok (Mesh_accounts.to_json alias)

let default_folder ~getenv backend =
  let variable, default_name, _ = agent_names backend in
  match (getenv variable, getenv "HOME") with
  | Some configured, _ when not (Filename.is_relative configured) ->
      Ok configured
  | _, Some home when not (Filename.is_relative home) ->
      Ok (Filename.concat home default_name)
  | _ -> folder_refused "no home folder for the default account"

let carry_folder ~uid ~getenv ~create (entry : entry) =
  let* folder =
    match entry.folder with
    | Some folder -> Ok folder
    | None -> default_folder ~getenv entry.backend
  in
  let checked =
    if create then Mesh_accounts.prepare_directory ~uid folder
    else Mesh_accounts.check_directory ~uid folder
  in
  match checked with
  | Ok () -> Ok folder
  | Error message -> folder_refused message

let protected_roots t = List.filter_map (fun (e : entry) -> e.folder) t.entries

let describe_current t backend current =
  let id = Option.value current ~default:default_id in
  let label, declared =
    match find t ({ backend; id } : account_ref) with
    | Ok entry -> (entry.label, true)
    | Error _ -> (id, false)
  in
  `Assoc
    [ ("id", `String id); ("label", `String label); ("declared", `Bool declared) ]

let to_host_json t =
  `Assoc [ ("accounts", `List (List.map Mesh_accounts.to_json t.aliases)) ]

let entry_json (entry : entry) =
  `Assoc
    [
      ("backend", `String (backend_to_string entry.backend));
      ("id", `String entry.id);
      ("label", `String entry.label);
    ]
