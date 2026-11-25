(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module P = Mesh_backend_profile

type backend = Claude | Codex | Opencode_v2 | Pi

let backend_of_string = function
  | "claude" -> Some Claude
  | "codex" -> Some Codex
  | "opencode-v2" -> Some Opencode_v2
  | "pi" -> Some Pi
  | _ -> None

let backend_to_string = function
  | Claude -> "claude"
  | Codex -> "codex"
  | Opencode_v2 -> "opencode-v2"
  | Pi -> "pi"

(* The variable an agent reads its folder from, the folder's name under $HOME
   for the default account, and the agent's name in messages. *)
let agent_names = function
  | Claude -> ("CLAUDE_CONFIG_DIR", ".claude", "Claude")
  | Codex -> ("CODEX_HOME", ".codex", "Codex")
  | Opencode_v2 -> ("XDG_CONFIG_HOME", ".config", "OpenCode")
  | Pi -> ("PI_CODING_AGENT_DIR", ".pi/agent", "Pi")

type account_ref = { backend : backend; id : string }

(* [folder] is None for the default account only. *)
type entry = {
  backend : backend;
  id : string;
  label : string;
  folder : string option;
  profile : (P.registry * P.t) option;
}

type t = {
  aliases : Mesh_accounts.account list;
  entries : entry list;
  registry : P.registry option;
}

type error = { code : string; message : string }

let default_id = "default"
let default_label = "Default account"
let fail code message = Error { code; message }
let refused message = fail "accounts_refused" message
let ( let* ) = Result.bind

let default_entry backend =
  {
    backend;
    id = default_id;
    label = default_label;
    folder = None;
    profile = None;
  }

let entries_of (alias : Mesh_accounts.account) =
  let entry backend = function
    | None -> []
    | Some folder ->
        [
          {
            backend;
            id = alias.id;
            label = alias.label;
            folder = Some folder;
            profile = None;
          };
        ]
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
  let* () = check_backend entries Opencode_v2 in
  let* () = check_backend entries Pi in
  Ok { aliases; entries; registry = None }

let profile_error error = "backend-profiles.json: " ^ P.error_code error

(* Missing roots may be prepared, as in accounts.json. A conversation root
   directly under a missing declared config root can be prepared after it;
   arbitrary missing ancestors are not created. Existing roots use the native
   validator too, including its physical-alias and ancestor custody checks. *)
let check_profile ~uid registry profile =
  let roots = List.map snd (P.roots profile) in
  let rec check path =
    match Unix.lstat path with
    | exception Unix.Unix_error (Unix.ENOENT, _, _) ->
        let parent = Filename.dirname path in
        if List.mem parent roots then check parent
        else Mesh_accounts.check_directory ~uid path
    | exception Unix.Unix_error _ -> Error (profile_error P.Unsafe_roots)
    | _ -> Mesh_accounts.check_directory ~uid path
  in
  let* () =
    List.fold_left
      (fun result path ->
        let* () = result in
        check path)
      (Ok ()) roots
  in
  Result.map_error profile_error (P.validate_roots ~registry ~allow_missing:true profile)

let aliases_of_entries entries =
  List.fold_left
    (fun aliases (entry : entry) ->
      let update (alias : Mesh_accounts.account) =
        match entry.backend with
        | Claude -> { alias with claude_config_dir = entry.folder }
        | Codex -> { alias with codex_home = entry.folder }
        | Opencode_v2 | Pi -> alias
      in
      if
        List.exists (fun (a : Mesh_accounts.account) -> a.id = entry.id) aliases
      then
        List.map
          (fun (a : Mesh_accounts.account) ->
            if a.id = entry.id then update a else a)
          aliases
      else
        aliases
        @ [
            update
              {
                Mesh_accounts.id = entry.id;
                label = entry.label;
                claude_config_dir = None;
                codex_home = None;
              };
          ])
    [] entries

let of_registry ~uid registry =
  let* () =
    List.fold_left
      (fun result profile ->
        let* () = result in
        Result.map_error
          (fun message -> { code = "accounts_refused"; message })
          (check_profile ~uid registry profile))
      (Ok ()) (P.profiles registry)
  in
  let entries =
    List.filter_map
      (fun profile ->
        let backend =
          match P.backend profile with
          | P.Claude -> Some Claude
          | P.Codex -> Some Codex
          | P.Opencode_v2 -> Some Opencode_v2
          | P.Pi -> Some Pi
        in
        if not (P.enabled profile) || P.managed profile then None
        else
          Option.map
            (fun backend ->
              {
                backend;
                id = P.id profile;
                label = P.label profile;
                folder = List.assoc_opt "config" (P.roots profile);
                profile = Some (registry, profile);
              })
            backend)
      (P.profiles registry)
  in
  Ok { aliases = aliases_of_entries entries; entries; registry = Some registry }

let load ~uid ~file =
  let legacy () =
    match Mesh_accounts.load ~uid file with
    | Error message -> refused message
    | Ok aliases -> of_accounts aliases
  in
  let root = Filename.dirname file in
  let root =
    if root = "." then Sys.getcwd ()
    else if Filename.is_relative root then Filename.concat (Sys.getcwd ()) root
    else root
  in
  let registry_file = Filename.concat root "backend-profiles.json" in
  (* lstat, not file_exists: dangling links are configured-but-refused, never
     permission to fall back to legacy credentials. *)
  match Unix.lstat registry_file with
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> (
      match Unix.lstat (Filename.concat root "backend-profiles.migrated") with
      | exception Unix.Unix_error (Unix.ENOENT, _, _) -> legacy ()
      | _ | (exception Unix.Unix_error _) ->
          refused
            "the migrated profile registry is missing; legacy fallback is \
             retired")
  | exception Unix.Unix_error _ -> refused (profile_error P.Unsafe_roots)
  | _ -> (
      if uid <> Unix.geteuid () then refused (profile_error P.Unsafe_roots)
      else
        match P.load ~root with
        | Error error -> refused (profile_error error)
        | Ok None -> refused (profile_error P.Invalid_config)
        | Ok (Some registry) -> of_registry ~uid registry)

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
      (List.map
         (fun (e : entry) -> Printf.sprintf "%s (%s)" e.id e.label)
         entries)

(* The accounts of [backend], default first. *)
let accounts_of t backend =
  default_entry backend
  :: List.filter (fun (e : entry) -> e.backend = backend) t.entries

let label_matches t backend name =
  let wanted = String.lowercase_ascii name in
  List.filter
    (fun (e : entry) -> String.lowercase_ascii e.label = wanted)
    (accounts_of t backend)

(* The exact id first, then every other account whose label is the name: when
   both match, the letter case alone must not pick the account. *)
let candidates t backend name =
  let labelled = label_matches t backend name in
  match
    List.find_opt (fun (e : entry) -> e.id = name) (accounts_of t backend)
  with
  | Some exact ->
      exact :: List.filter (fun (e : entry) -> e.id <> exact.id) labelled
  | None -> labelled

let resolve_name t backend name =
  match candidates t backend name with
  | [ entry ] -> Ok entry
  | [] -> find t ({ backend; id = name } : account_ref)
  | several -> fail "account_ambiguous" (candidates_message several)

(* No absolute path (a word starting with "/" becomes "<path>") and no control
   character ("?"): the rule Carry_base.sanitize applies to the messages of
   [carry]. *)
let sanitize message =
  let length = String.length message in
  let buffer = Buffer.create length in
  let rec skip_path index =
    if index < length && message.[index] <> ' ' && message.[index] <> ':' then
      skip_path (index + 1)
    else index
  in
  let rec copy index =
    if index < length then
      let character = message.[index] in
      if character = '/' && (index = 0 || message.[index - 1] = ' ') then begin
        Buffer.add_string buffer "<path>";
        copy (skip_path index)
      end
      else begin
        Buffer.add_char buffer
          (if Char.code character < 0x20 || Char.code character = 0x7f then '?'
           else character);
        copy (index + 1)
      end
  in
  copy 0;
  Buffer.contents buffer

let resolve ~uid ~file backend name =
  let sanitized error = { error with message = sanitize error.message } in
  match load ~uid ~file with
  | Error error -> Error (sanitized error, [])
  | Ok t -> (
      match resolve_name t backend name with
      | Ok entry -> Ok entry
      | Error error when error.code = "account_ambiguous" ->
          Error (sanitized error, candidates t backend name)
      | Error error -> Error (sanitized error, []))

let serves t ~id backend = Result.is_ok (find t ({ backend; id } : account_ref))

let ref_ (entry : entry) : account_ref =
  { backend = entry.backend; id = entry.id }

let label (entry : entry) = entry.label

let context_revision (entry : entry) =
  Option.map (fun (_, profile) -> P.context_revision profile) entry.profile

let launch_env (entry : entry) =
  match entry.folder with
  | None -> []
  | Some folder ->
      let variable, _, _ = agent_names entry.backend in
      [ (variable, folder) ]

type launch_context = {
  backend : backend;
  id : string;
  label : string;
  registry_revision : string option;
  context_revision : string option;
  roots : (string * string) list;
  env : (string * string) list;
  unset : string list;
}

let folder_refused message = fail "account_folder_refused" message

let prepare ~uid (entry : entry) =
  match (entry.profile, entry.folder) with
  | Some (registry, profile), _ ->
      let* () =
        if uid = Unix.geteuid () then Ok ()
        else folder_refused (profile_error P.Unsafe_roots)
      in
      let* () =
        Result.map_error
          (fun message -> { code = "account_folder_refused"; message })
          (check_profile ~uid registry profile)
      in
      let* () =
        List.fold_left
          (fun result folder ->
            let* () = result in
            Result.map_error
              (fun message -> { code = "account_folder_refused"; message })
              (Mesh_accounts.prepare_directory ~uid folder))
          (Ok ())
          (List.sort
             (fun a b -> Int.compare (String.length a) (String.length b))
             (List.map snd (P.roots profile)))
      in
      let* () =
        Result.map_error
          (fun error ->
            { code = "account_folder_refused"; message = profile_error error })
          (P.validate_roots ~registry profile)
      in
      Ok entry
  | None, None -> Ok entry
  | None, Some folder -> (
      match Mesh_accounts.prepare_directory ~uid folder with
      | Ok () -> Ok entry
      | Error message -> folder_refused message)

let profile_unset backend =
  let common =
    [ "ANTHROPIC_API_KEY"; "ANTHROPIC_AUTH_TOKEN"; "OPENAI_API_KEY";
      "GOOGLE_API_KEY"; "GEMINI_API_KEY"; "OPENROUTER_API_KEY";
      "AZURE_OPENAI_API_KEY"; "GOOGLE_GENERATIVE_AI_API_KEY";
      "OPENAI_BASE_URL"; "ANTHROPIC_BASE_URL" ]
  in
  List.sort_uniq String.compare
    (common
    @
    match backend with
    | Claude ->
        [ "CLAUDE_CODE_OAUTH_TOKEN"; "CLAUDE_CODE_OAUTH_REFRESH_TOKEN";
          "CLAUDE_CODE_USE_BEDROCK"; "CLAUDE_CODE_USE_VERTEX";
          "CLAUDE_CODE_USE_FOUNDRY"; "AWS_BEARER_TOKEN_BEDROCK";
          "ANTHROPIC_FOUNDRY_API_KEY" ]
    | Codex -> [ "CODEX_API_KEY"; "CODEX_ACCESS_TOKEN" ]
    | Pi -> []
    | Opencode_v2 ->
        [ "OPENCODE_DB"; "OPENCODE_CONFIG"; "OPENCODE_CONFIG_CONTENT" ])

let launch_context ~uid ?expected_context entry =
  let* () =
    match (expected_context, entry.profile) with
    | None, _ -> Ok ()
    | Some expected, Some (_, profile)
      when expected = P.context_revision profile ->
        Ok ()
    | Some _, _ ->
        fail "profile-context-changed" "selected profile context changed"
  in
  let* entry = prepare ~uid entry in
  let roots, env, registry_revision, context_revision =
    match entry.profile with
    | None ->
        ( (match entry.folder with None -> [] | Some path -> [ ("config", path) ]),
          launch_env entry, None, None )
    | Some (registry, profile) ->
        let roots = P.roots profile in
        let env =
          match entry.backend with
          | Claude | Codex -> launch_env entry
          | Pi -> [ ("PI_CODING_AGENT_DIR", List.assoc "config" roots) ]
          | Opencode_v2 ->
              List.map
                (fun (role, variable) -> (variable, List.assoc role roots))
                [ ("cache", "XDG_CACHE_HOME"); ("config", "XDG_CONFIG_HOME");
                  ("data", "XDG_DATA_HOME"); ("state", "XDG_STATE_HOME") ]
        in
        (roots, env, Some (P.registry_revision registry),
         Some (P.context_revision profile))
  in
  Ok
    { backend = entry.backend; id = entry.id; label = entry.label;
      registry_revision; context_revision; roots; env;
      unset = profile_unset entry.backend }

let launch_context_json context =
  let strings fields =
    `Assoc (List.map (fun (key, value) -> (key, `String value)) fields)
  in
  let optional key = function
    | None -> []
    | Some value -> [ (key, `String value) ]
  in
  `Assoc
    ([ ("backend", `String (backend_to_string context.backend));
       ("id", `String context.id); ("label", `String context.label);
       ("roots", strings context.roots); ("env", strings context.env);
       ("unset", `List (List.map (fun name -> `String name) context.unset)) ]
    @ optional "registry_revision" context.registry_revision
    @ optional "context_revision" context.context_revision)

let alias_json t (alias : Mesh_accounts.account) =
  let json = Mesh_accounts.to_json alias in
  match (t.registry, json) with
  | None, _ -> json
  | Some _, `Assoc fields ->
      let labels =
        List.filter_map
          (fun (entry : entry) ->
            if entry.id = alias.id then
              Some (backend_to_string entry.backend, `String entry.label)
            else None)
          t.entries
      in
      `Assoc (fields @ [ ("backend_labels", `Assoc labels) ])
  | _ -> json

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
      Ok (alias_json t alias)

let default_folder ~getenv backend =
  let variable, default_name, _ = agent_names backend in
  match (getenv variable, getenv "HOME") with
  | Some configured, _ when not (Filename.is_relative configured) ->
      Ok configured
  | _, Some home when not (Filename.is_relative home) ->
      Ok (Filename.concat home default_name)
  | _ -> folder_refused "no home folder for the default account"

let carry_folder ~uid ~getenv ~create (entry : entry) =
  let* () =
    match entry.profile with
    | None -> Ok ()
    | Some (registry, profile) ->
        let* () =
          if uid = Unix.geteuid () then Ok ()
          else folder_refused (profile_error P.Unsafe_roots)
        in
        Result.map_error
          (fun message -> { code = "account_folder_refused"; message })
          (check_profile ~uid registry profile)
  in
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
  | Ok () ->
      let* () =
        match entry.profile with
        | None -> Ok ()
        | Some (registry, profile) ->
            Result.map_error
              (fun message -> { code = "account_folder_refused"; message })
              (check_profile ~uid registry profile)
      in
      Ok folder
  | Error message -> folder_refused message

let protected_roots t =
  match t.registry with
  | None -> List.filter_map (fun (e : entry) -> e.folder) t.entries
  | Some registry ->
      List.concat_map
        (fun profile ->
          List.filter_map
            (fun (role, path) ->
              if
                role = "config"
                || P.backend profile = P.Opencode_v2
                   && (role = "data" || role = "state")
              then Some path
              else None)
            (P.roots profile))
        (P.profiles registry)

let describe_current t backend current =
  let id = Option.value current ~default:default_id in
  let label, declared =
    match find t ({ backend; id } : account_ref) with
    | Ok entry -> (entry.label, true)
    | Error _ -> (id, false)
  in
  `Assoc
    [
      ("id", `String id); ("label", `String label); ("declared", `Bool declared);
    ]

let entry_json (entry : entry) =
  `Assoc
    [
      ("backend", `String (backend_to_string entry.backend));
      ("id", `String entry.id);
      ("label", `String entry.label);
    ]

let to_host_json t =
  let fields = [ ("accounts", `List (List.map (alias_json t) t.aliases)) ] in
  `Assoc
    (match t.registry with
    | None -> fields
    | Some _ ->
        fields
        @ [
            ( "protected_roots",
              `List (List.map (fun p -> `String p) (protected_roots t)) );
            ("launch_profiles", `List (List.map entry_json t.entries));
          ])
