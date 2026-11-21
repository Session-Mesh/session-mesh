(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

include Mesh_project_store_io

let upgraded config projects =
  assoc
    ([
       ("schema_version", `Int 2);
       ( "features",
         `List
           ([ s "project-metadata/1"; s "project-workspace/1" ]
           @
           if
             List.exists
               (fun p -> List.mem_assoc "observation" (C.obj p))
               projects
             ||
             match List.assoc_opt "features" (C.obj config) with
             | Some (`List fs) -> List.mem (s "project-observation/1") fs
             | _ -> false
           then [ s "project-observation/1" ]
           else []) );
       ("projects", `List projects);
     ]
    @ List.filter
        (fun (key, _) ->
          not (List.mem key [ "schema_version"; "features"; "projects" ]))
        (C.obj config))

let detail_identity project =
  let fields = C.obj project in
  [ ("id", C.get fields "id"); ("title", C.get fields "title") ]
  @ List.map
      (fun (key, count) -> (key, `Int count))
      [
        ("folders_total", fields_count project "folders");
        ("sources_total", fields_count project "sources");
        ("sessions_total", fields_count project "sessions");
        ("participations_total", fields_count project "participations");
      ]

let project_optional_field key value =
  match key with
  | "repository" ->
      let fields = C.obj value in
      assoc
        [
          ("url", C.get fields "url");
          ("extra_fields", `Int (List.length fields - 1));
        ]
  | "sources" -> (
      let source value =
        assoc
          (List.filter
             (fun (key, _) -> List.mem key [ "id"; "kind"; "label"; "url" ])
             (C.obj value))
      in
      match value with
      | `List sources -> `List (List.map source sources)
      | _ -> assert false)
  | _ -> value

let detail store operation config revision project =
  let reply (fields, omitted) =
    envelope store operation "ok"
      (identity config revision
      @ [
          ("project", assoc fields);
          ("omitted_fields", `List (List.map s omitted));
        ])
  in
  let add_optional ((fields, omitted) as current) key =
    let value =
      match List.assoc_opt key (C.obj project) with
      | None when key = "sessions" -> Some (`List [])
      | value -> value
    in
    match value with
    | None -> current
    | Some value ->
        let candidate =
          (fields @ [ (key, project_optional_field key value) ], omitted)
        in
        (* Reserve space for every whole-field omission name. *)
        if String.length (C.encode (reply candidate)) > C.reply_bytes - 256 then
          (fields, omitted @ [ key ])
        else candidate
  in
  reply
    (List.fold_left add_optional
       (detail_identity project, [])
       [ "description"; "folders"; "repository"; "sources"; "sessions" ])

let capability store operation =
  envelope store operation "ok"
    [
      ("mode", s "normal");
      ("store", s "unchecked");
      ("features", `List [ s "project-registry/1"; s "project-session-tools/1" ]);
      ("operations", `List (List.map s C.operations));
      ( "limits",
        assoc
          [
            ("request_bytes", `Int C.request_bytes);
            ("reply_bytes", `Int C.reply_bytes);
            ("config_bytes", `Int C.config_bytes);
            ("max_folders", `Int 100);
            ("max_sources", `Int 20);
            ("max_source_changes", `Int 40);
            ("max_sessions", `Int 100);
            ("max_session_changes", `Int 40);
          ] );
    ]

type snapshot = {
  old : string option;
  config : Yojson.Basic.t option;
  revision : string;
}

let project_rows snapshot = Option.fold ~none:[] ~some:rows snapshot.config

let find_project snapshot project_id =
  List.find_opt
    (fun project -> C.get (C.obj project) "id" = s project_id)
    (project_rows snapshot)

let list_projects store operation snapshot =
  match snapshot.config with
  | None ->
      envelope store operation "uninitialized"
        [
          ("revision", s snapshot.revision);
          ("projects", `List []);
          ("total", `Int 0);
          ("complete", `Bool true);
        ]
  | Some config ->
      let summary project =
        let fields = C.obj project in
        assoc [ ("id", C.get fields "id"); ("title", C.get fields "title") ]
      in
      let projects = List.map summary (rows config) in
      envelope store operation "ok"
        (identity config snapshot.revision
        @ [
            ("projects", `List projects);
            ("total", `Int (List.length projects));
            ("complete", `Bool true);
          ])

let read_project store operation fields snapshot =
  let project_id = C.id (C.get fields "project_id") in
  match (find_project snapshot project_id, snapshot.config) with
  | Some project, Some config -> (
      let reply = detail store operation config snapshot.revision project in
      match List.assoc_opt "settings" fields with
      | None -> reply
      | Some target ->
          let target = C.obj target and p = C.obj project in
          let sources =
            match List.assoc_opt "sources" p with
            | Some (`List xs) -> xs
            | _ -> []
          in
          let selector source =
            let a = C.obj source in
            match
              (List.assoc_opt "board_path" a, List.assoc_opt "pipeline_root" a)
            with
            | Some path, _ -> assoc [ ("kind", s "board"); ("path", path) ]
            | _, Some root ->
                assoc
                  [
                    ("kind", s "pipeline");
                    ("root", root);
                    ("task", C.get a "pipeline_task");
                  ]
            | _ -> `Null
          in
          let optional k = Option.value ~default:`Null (List.assoc_opt k p) in
          let settings =
            match C.get target "kind" with
            | `String "project" ->
                C.keys target [ "kind" ];
                let repository =
                  match optional "repository" with
                  | `Null -> `Null
                  | repo ->
                      assoc
                        (List.filter
                           (fun (k, _) ->
                             List.mem k [ "url"; "local_path"; "primary_ref" ])
                           (C.obj repo))
                in
                assoc
                  [
                    ("kind", s "project");
                    ("plan", optional "observation");
                    ("repository", repository);
                    ( "source_summaries",
                      `List
                        (List.map
                           (fun source ->
                             let a = C.obj source in
                             assoc
                               [
                                 ("id", C.get a "id");
                                 ("kind", C.get a "kind");
                                 ("label", C.get a "label");
                                 ( "selector_configured",
                                   `Bool (selector source <> `Null) );
                               ])
                           sources) );
                  ]
            | `String "source" ->
                C.keys target [ "kind"; "source_id" ];
                let sid = C.id (C.get target "source_id") in
                let source =
                  match
                    List.find_opt
                      (fun v -> C.get (C.obj v) "id" = s sid)
                      sources
                  with
                  | Some v -> v
                  | None -> outcome "refused" "unknown-source"
                in
                assoc
                  [
                    ("kind", s "source");
                    ( "source",
                      assoc
                        (("selector", selector source)
                        :: List.filter
                             (fun (k, _) ->
                               List.mem k [ "id"; "kind"; "label"; "url" ])
                             (C.obj source)) );
                  ]
            | _ -> outcome "refused" "invalid-request"
          in
          let candidate =
            assoc (("observation_settings", settings) :: C.obj reply)
          in
          if String.length (C.encode candidate) > C.reply_bytes then
            outcome "refused" "result-capacity";
          candidate)
  | _ -> outcome "refused" "unknown-project"

let retained_kind project request_id =
  let matched kind =
    Option.bind project (fun project ->
        Option.bind
          (List.assoc_opt kind (C.obj project))
          (fun receipt ->
            if C.get (C.obj receipt) "request_id" = s request_id then Some kind
            else None))
  in
  match matched "creation" with
  | Some _ -> Some "create"
  | None -> Option.map (fun _ -> "settings") (matched "last_settings")

let intent_state store project_id request_id project retained =
  if retained <> None then "confirmed"
  else if pending store (project_id, request_id) || locked store then "pending"
  else if project = None then "absent"
  else "unknown"

let project_status store operation fields snapshot =
  let project_id = C.id (C.get fields "project_id")
  and request_id = C.uuid (C.get fields "request_id") in
  let project = find_project snapshot project_id in
  let retained = retained_kind project request_id in
  let context =
    match snapshot.config with
    | None -> [ ("revision", s snapshot.revision) ]
    | Some config -> identity config snapshot.revision
  in
  envelope store operation "ok"
    ([
       ("project_id", s project_id);
       ("request_id", s request_id);
       ( "intent_state",
         s (intent_state store project_id request_id project retained) );
       ("intent_kind", match retained with None -> `Null | Some kind -> s kind);
     ]
    @ context)

let mutation_ids operation fields =
  let request_id = C.uuid (C.get fields "request_id") in
  let project_id =
    if operation = "project_create" then request_id
    else C.id (C.get fields "project_id")
  in
  (project_id, request_id)

let mutation_payload operation fields =
  if operation = "project_create" then
    C.normalized_create (C.get fields "project")
  else
    let patch = C.get fields "patch" in
    C.strict patch;
    C.canonical patch

type mutation = {
  project_id : string;
  request_id : string;
  payload : Yojson.Basic.t;
  sha256 : string;
  previous : Yojson.Basic.t option;
  receipt_key : string;
}

let prepare_mutation operation fields snapshot =
  let project_id, request_id = mutation_ids operation fields in
  let payload = mutation_payload operation fields in
  {
    project_id;
    request_id;
    payload;
    sha256 = C.digest (C.encode payload);
    previous = find_project snapshot project_id;
    receipt_key =
      (if operation = "project_create" then "creation" else "last_settings");
  }

let retained_replay mutation =
  let receipt =
    Option.bind mutation.previous (fun project ->
        List.assoc_opt mutation.receipt_key (C.obj project))
  in
  match receipt with
  | Some receipt when C.get (C.obj receipt) "request_id" = s mutation.request_id
    ->
      if C.get (C.obj receipt) "sha256" <> s mutation.sha256 then
        outcome "conflict" "immutable-identity";
      true
  | _ -> false

let validate_mutation operation fields snapshot mutation replay =
  if operation = "project_create" && mutation.previous <> None && not replay
  then outcome "conflict" "immutable-identity";
  if (not replay) && C.get fields "expected_revision" <> s snapshot.revision
  then outcome "conflict" "revision-conflict";
  if operation = "project_settings" && mutation.previous = None then
    outcome "refused" "unknown-project"

let mutation_config store snapshot =
  match snapshot.config with
  | Some config -> config
  | None ->
      assoc
        [
          ("kind", s "mesh-project-config");
          ("schema_version", `Int 1);
          ("machine_id", s (store.machine ()));
          ("projects", `List []);
        ]

let changed_project operation mutation =
  let project =
    if operation = "project_create" then
      assoc (("id", s mutation.project_id) :: C.obj mutation.payload)
    else C.patch (Option.get mutation.previous) mutation.payload
  in
  let receipt =
    assoc
      [ ("request_id", s mutation.request_id); ("sha256", s mutation.sha256) ]
  in
  assoc
    ((mutation.receipt_key, receipt)
    :: List.remove_assoc mutation.receipt_key (C.obj project))

let publish_mutation store operation snapshot mutation config deadline =
  let projects = project_rows snapshot in
  if operation = "project_create" && List.length projects >= 100 then
    outcome "refused" "capacity";
  let project = changed_project operation mutation in
  let projects =
    if operation = "project_create" then projects @ [ project ]
    else
      List.map
        (fun previous ->
          if C.get (C.obj previous) "id" = s mutation.project_id then project
          else previous)
        projects
  in
  let revision =
    publish store ~old:snapshot.old ~deadline (upgraded config projects)
  in
  store.observe_revision revision;
  (revision, if operation = "project_create" then "created" else "updated")

let mutate store operation fields snapshot deadline =
  let mutation = prepare_mutation operation fields snapshot in
  let replay = retained_replay mutation in
  validate_mutation operation fields snapshot mutation replay;
  let config = mutation_config store snapshot in
  let revision, result =
    if replay then (snapshot.revision, "replayed")
    else publish_mutation store operation snapshot mutation config deadline
  in
  envelope store operation "ok"
    (identity config revision
    @ [
        ("project_id", s mutation.project_id);
        ("request_id", s mutation.request_id);
        ("result", s result);
      ])

let request_op fields =
  match
    List.find_opt
      (fun (key, value) ->
        key = "op"
        &&
        match value with
        | `String operation -> C.is_operation operation
        | _ -> false)
      fields
  with
  | Some (_, `String operation) -> operation
  | _ -> "project_capabilities"

let request_keys = function
  | "project_capabilities" | "project_list" -> [ "op"; "version" ]
  | "project_read" -> [ "op"; "version"; "project_id"; "settings" ]
  | "project_status" -> [ "op"; "version"; "project_id"; "request_id" ]
  | "project_create" ->
      [ "op"; "version"; "boot"; "expected_revision"; "request_id"; "project" ]
  | "project_settings" ->
      [
        "op";
        "version";
        "boot";
        "expected_revision";
        "request_id";
        "project_id";
        "patch";
      ]
  | _ -> []

let validate_request operation fields =
  if List.mem_assoc "__project_request_oversize" fields then
    outcome "refused" "request-oversize";
  let input = assoc fields in
  C.strict input;
  if String.length (C.encode input) > C.request_bytes then
    outcome "refused" "request-oversize";
  if C.get fields "op" <> s operation || C.get fields "version" <> `Int 1 then
    raise (C.Invalid "invalid-request");
  C.keys fields (request_keys operation)

let is_mutation operation =
  List.mem operation [ "project_create"; "project_settings" ]

let with_writer store operation fields deadline work =
  (* The host bounds admitted waiting/running system threads to four. A
     retained external/dead-writer lock stays busy and is never stolen. *)
  with_intent store (mutation_ids operation fields) (fun () ->
      Mutex.lock store.writer;
      Fun.protect
        ~finally:(fun () -> Mutex.unlock store.writer)
        (fun () ->
          check_deadline store deadline;
          with_lock store work))

let dispatch store operation fields snapshot deadline =
  match operation with
  | "project_list" -> list_projects store operation snapshot
  | "project_read" -> read_project store operation fields snapshot
  | "project_status" -> project_status store operation fields snapshot
  | "project_create" | "project_settings" ->
      mutate store operation fields snapshot deadline
  | _ -> outcome "refused" "invalid-request"

let run_supported store operation fields current_revision =
  validate_request operation fields;
  if operation = "project_capabilities" then capability store operation
  else (
    if is_mutation operation && C.get fields "boot" <> s store.boot then
      outcome "conflict" "stale-host";
    let deadline = store.now () +. 4.5 in
    let work () =
      let old, config, revision = read store in
      store.observe_revision revision;
      current_revision := Some revision;
      store.hook Read;
      dispatch store operation fields { old; config; revision } deadline
    in
    if is_mutation operation then
      with_writer store operation fields deadline work
    else work ())

let run store ~isolated fields =
  let operation = request_op fields in
  let ids = identifiers operation fields and current_revision = ref None in
  let err status code =
    let context =
      match !current_revision with
      | Some revision -> [ ("revision", s revision) ]
      | None -> []
    in
    envelope store operation status ([ ("code", s code) ] @ ids @ context)
  in
  if isolated then err "unsupported" "identity-split"
  else
    try run_supported store operation fields current_revision with
    | Outcome (status, code) -> err status code
    | C.Invalid code -> err "refused" code
    | Unix.Unix_error _ | Sys_error _ | Failure _ ->
        err "unavailable" "store-unavailable"
    | Yojson.Json_error _ -> err "unavailable" "invalid-config"

let observe_revision store callback = store.observe_revision <- callback

let capture store ~machine_id ~project_id ~expected_revision =
  let _, config, revision = read store in
  store.observe_revision revision;
  store.hook Read;
  if revision <> expected_revision then outcome "stale" "revision-conflict";
  let config =
    match config with Some v -> v | None -> outcome "failed" "unknown-project"
  in
  let a = C.obj config in
  if C.get a "machine_id" <> s machine_id then
    outcome "failed" "identity-mismatch";
  let project =
    match
      List.find_opt (fun p -> C.get (C.obj p) "id" = s project_id) (rows config)
    with
    | Some p -> p
    | None -> outcome "failed" "unknown-project"
  in
  let p = C.obj project in
  let plan =
    match List.assoc_opt "observation" p with
    | Some v -> v
    | None -> outcome "failed" "unsupported-feature"
  in
  let selected =
    List.filter
      (fun (k, _) ->
        not
          (List.mem k [ "folders"; "creation"; "last_settings"; "observation" ]))
      p
  in
  let config =
    assoc
      [
        ("kind", s "mesh-project-config");
        ("schema_version", `Int 2);
        ("features", `List [ s "project-metadata/1" ]);
        ("machine_id", s machine_id);
        ("projects", `List [ assoc selected ]);
      ]
  in
  (config, plan)
