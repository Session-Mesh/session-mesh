(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

include Mesh_project_values

let project ~modern ~workspace v =
  let a = obj v in
  keys a
    ([ "id"; "title"; "description"; "repository"; "sources"; "sessions" ]
    @ (if modern then [ "participations"; "observation" ] else [ "observation" ])
    @ if workspace then [ "folders"; "creation"; "last_settings" ] else []);
  ignore (id (get a "id"));
  ignore (text 240 (get a "title"));
  opt a "description" (text ~empty:true 4000);
  opt a "repository" (repository ~modern);
  opt a "sources" (fun v ->
      let xs =
        list 20
          (fun v ->
            source ~modern v;
            v)
          v
      in
      unique (fun x -> id (get (obj x) "id")) xs;
      xs);
  opt a "sessions" (list 100 session);
  opt a "participations" (fun v ->
      let xs =
        list 100
          (fun v ->
            participation v;
            v)
          v
      in
      unique (fun x -> id (get (obj x) "id")) xs;
      xs);
  opt a "folders" folders;
  if List.mem_assoc "observation" a && not (modern && workspace) then fail "unsupported-feature";
  opt a "observation" (observation a);
  List.iter (fun k -> opt a k receipt) [ "creation"; "last_settings" ];
  opt a "creation" (fun v ->
      if get (obj v) "request_id" <> get a "id" then fail "invalid-request")

let validate_config v =
  strict v;
  let a = obj v in
  keys a [ "kind"; "schema_version"; "features"; "machine_id"; "projects" ];
  if get a "kind" <> `String "mesh-project-config" then fail "invalid-config";
  let modern = get a "schema_version" = `Int 2 in
  let workspace = ref false in
  if modern then (
    let fs =
      list 3
        (fun v ->
          let feature = text 80 v in
          if
            not
              (List.mem feature [ "project-metadata/1"; "project-workspace/1"; "project-observation/1" ])
          then fail "unsupported-feature";
          feature)
        (get a "features")
    in
    unique Fun.id fs;
    if not (List.mem "project-metadata/1" fs) then fail "unsupported-feature";
    workspace := List.mem "project-workspace/1" fs)
  else if get a "schema_version" <> `Int 1 || List.mem_assoc "features" a then
    fail "unsupported-feature";
  ignore (id (get a "machine_id"));
  let projects =
    list 100
      (fun v ->
        project ~modern ~workspace:!workspace v;
        v)
      (get a "projects")
  in
  unique (fun x -> id (get (obj x) "id")) projects;
  if List.exists (fun p -> List.mem_assoc "observation" (obj p)) projects then (
    match List.assoc_opt "features" a with
    | Some (`List fs) when List.mem (`String "project-observation/1") fs -> ()
    | _ -> fail "unsupported-feature");
  if
    List.fold_left
      (fun n p ->
        n
        +
        match List.assoc_opt "sources" (obj p) with
        | Some (`List xs) -> List.length xs
        | _ -> 0)
      0 projects
    > 1000
  then fail "capacity";
  v

let rec canonical = function
  | `Assoc a ->
      `Assoc
        (List.map
           (fun (k, v) -> (k, canonical v))
           (List.sort (fun (a, _) (b, _) -> String.compare a b) a))
  | `List xs -> `List (List.map canonical xs)
  | v -> v

let digest s = Digestif.SHA256.(to_hex (digest_string s))
let encode v = Yojson.Basic.to_string v

let scan_quoted quoted escaped character =
  if !escaped then escaped := false
  else
    match character with
    | '\\' -> escaped := true
    | '"' -> quoted := false
    | _ -> ()

let parse_document ~max_bytes bytes =
  if String.length bytes > max_bytes then fail "capacity";
  let depth = ref 0 and quoted = ref false and escaped = ref false in
  String.iter
    (fun c ->
      if !quoted then scan_quoted quoted escaped c
      else
        match c with
        | '"' -> quoted := true
        | '[' | '{' ->
            incr depth;
            if !depth > 128 then fail "invalid-config"
        | ']' | '}' -> decr depth
        | _ -> ())
    bytes;
  let value = Yojson.Basic.from_string bytes in
  strict value;
  value

let parse_config bytes = validate_config (parse_document ~max_bytes:config_bytes bytes)

let normalized_create v =
  let a = obj v in
  keys a [ "title"; "description"; "folders"; "repository"; "sources"; "observation" ];
  let title = trim (text 240 (get a "title")) in
  if title = "" then fail "invalid-request";
  let fields =
    ref
      [
        ("title", `String title); ("sources", `List []); ("sessions", `List []);
      ]
  in
  List.iter
    (fun k ->
      match List.assoc_opt k a with
      | None -> ()
      | Some `Null when List.mem k [ "repository"; "observation" ] -> ()
      | Some (`String s) when k = "description" && trim s = "" -> ()
      | Some (`List []) when k = "folders" -> ()
      | Some v -> fields := (k, v) :: List.remove_assoc k !fields)
    [ "description"; "folders"; "repository"; "sources"; "observation" ];
  (* Create accepts only the editable source/repository vocabulary. *)
  opt a "repository" (function `Null -> () | v -> keys (obj v) [ "url"; "local_path"; "primary_ref" ]);
  (match List.assoc_opt "sources" a with
  | None -> ()
  | Some value ->
      let sources = list 20 (fun v ->
          let source = obj v in
          keys source [ "id"; "kind"; "label"; "url"; "selector" ];
          let raw = List.remove_assoc "selector" source in
          `Assoc (match List.assoc_opt "selector" source with
              | None -> raw
              | Some selected -> selector selected @ raw)) value in
      fields := ("sources", `List sources) :: List.remove_assoc "sources" !fields);
  let value = `Assoc !fields in
  project ~modern:true ~workspace:true
    (`Assoc (("id", `String "validation") :: !fields));
  canonical value

let with_selector fields value =
  selector value @ List.filter (fun (k, _) -> not (List.mem k [ "board_path"; "pipeline_root"; "pipeline_task" ])) fields

let source_put previous source_id change =
  keys change [ "type"; "id"; "kind"; "label"; "url"; "selector" ];
  let base =
    match previous with
    | Some value -> obj value
    | None -> [ ("id", `String source_id) ]
  in
  let put fields (key, value) =
    if not (List.mem key [ "kind"; "label"; "url" ]) then fields
    else (
      if
        key = "kind" && previous <> None
        && List.assoc_opt key fields <> Some value
      then fail "invalid-request";
      let fields = List.remove_assoc key fields in
      if value = `Null && key = "url" then fields else (key, value) :: fields)
  in
  let fields = List.fold_left put base change in
  let fields = match List.assoc_opt "selector" change with None -> fields | Some v -> with_selector fields v in
  let value = `Assoc fields in
  source ~modern:true value;
  value

let source_change sources value =
  let change = obj value in
  let source_id = id (get change "id") in
  let matches value = get (obj value) "id" = `String source_id in
  let previous = List.find_opt matches sources in
  let rest = List.filter (fun value -> not (matches value)) sources in
  match get change "type" with
  | `String "remove" ->
      keys change [ "type"; "id" ];
      if previous = None then fail "unknown-project";
      rest
  | `String "put" -> rest @ [ source_put previous source_id change ]
  | `String "selector" ->
      keys change [ "type"; "id"; "selector" ];
      let old = match previous with Some v -> obj v | None -> fail "unknown-project" in
      if get old "kind" <> `String "roster" then fail "invalid-request";
      let value = `Assoc (with_selector old (get change "selector")) in
      source ~modern:true value;
      rest @ [ value ]
  | _ -> fail "invalid-request"

let patch_sources original value =
  let sources =
    match List.assoc_opt "sources" original with
    | Some (`List sources) -> sources
    | _ -> []
  in
  (* Forty changes can replace all twenty references. Final schema validation
     still enforces the twenty-source bound. *)
  let changes = list 40 Fun.id value in
  unique (fun change -> id (get (obj change) "id")) changes;
  `List (List.fold_left source_change sources changes)

let patch_repository original value =
  let repository = obj value in
  keys repository [ "url"; "local_path"; "primary_ref" ];
  let previous =
    match List.assoc_opt "repository" original with
    | Some value -> obj value
    | None -> []
  in
  `Assoc (List.fold_left (fun fields (key, value) ->
      let rest = List.remove_assoc key fields in
      if value = `Null then rest else (key, value) :: rest) previous repository)

let same_session a b =
  let a = obj a and b = obj b in
  let same_epoch a b = match a, b with
    | `Int a, `Int b -> a = b
    | `Float a, `Float b -> a = b
    | `Int n, `Float f | `Float f, `Int n ->
        Float.is_integer f && f >= 0. && f <= float_of_int max_int
        && Int64.of_float f = Int64.of_int n
    | _ -> false
  in
  get a "name" = get b "name" && List.assoc_opt "machine_id" a = List.assoc_opt "machine_id" b
  && same_epoch (get a "created") (get b "created")

let patch_sessions original value =
  let previous = match List.assoc_opt "sessions" original with Some (`List xs) -> xs | _ -> [] in
  let changes = list 40 (fun change ->
      let fields = obj change in
      keys fields ["type"; "session"];
      let reference = get fields "session" in
      session reference;
      ignore (id (get (obj reference) "machine_id"));
      (choice ["attach"; "detach"] (get fields "type"), reference)) value in
  `List (List.fold_left (fun sessions (operation, reference) ->
      if operation = "detach" then List.filter (fun old -> not (same_session old reference)) sessions
      else if List.exists (same_session reference) sessions then sessions
      else sessions @ [reference]) previous changes)

let patch_field original fields (key, value) =
  let set value = (key, value) :: List.remove_assoc key fields in
  match (key, value) with
  | "title", value ->
      let title = trim (text 240 value) in
      if title = "" then fail "invalid-request";
      set (`String title)
  | "description", `Null | "repository", `Null | "observation", `Null -> List.remove_assoc key fields
  | "observation", value -> set value
  | "description", value ->
      let description = text ~empty:true 4000 value in
      if trim description = "" then List.remove_assoc key fields else set value
  | "folders", value ->
      ignore (folders value);
      set value
  | "repository", value -> set (patch_repository original value)
  | "source_changes", value ->
      ("sources", patch_sources original value)
      :: List.remove_assoc "sources" fields
  | "session_changes", value ->
      ("sessions", patch_sessions original value)
      :: List.remove_assoc "sessions" fields
  | _ -> fail "invalid-request"

let patch original value =
  let changes = obj value and original = obj original in
  keys changes
    [ "title"; "description"; "folders"; "repository"; "source_changes"; "session_changes"; "observation" ];
  if changes = [] then fail "invalid-request";
  let result =
    `Assoc (List.fold_left (patch_field original) original changes)
  in
  project ~modern:true ~workspace:true result;
  result
