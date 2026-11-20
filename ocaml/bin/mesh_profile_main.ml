(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

module P = Mesh_backend_profile
module C = Mesh_backend_consent
module S = Mesh_backend_store

let ( let* ) = Result.bind
let project error result = Result.map_error error result

let exact names = function
  | `Assoc fields
    when List.length fields = List.length names
         && List.sort_uniq String.compare (List.map fst fields)
            = List.sort String.compare names ->
      Ok fields
  | _ -> Error "invalid-request"

let field name fields =
  match List.assoc_opt name fields with
  | Some v -> Ok v
  | None -> Error "invalid-request"

let id name fields =
  let* raw = field name fields in
  match raw with
  | `String value when P.valid_id value -> Ok value
  | _ -> Error "invalid-request"

let revision fields =
  let* raw = field "expected_revision" fields in
  match raw with
  | `Int n when n >= 0 && n <= 9007199254740991 -> Ok n
  | _ -> Error "invalid-request"

let confirmation fields =
  let* raw = field "confirmation" fields in
  match raw with
  | `String "ask" -> Ok C.Ask
  | `String "skip" -> Ok C.Skip
  | _ -> Error "invalid-request"

let parse_backend = function
  | `String "claude" -> Ok P.Claude
  | `String "codex" -> Ok P.Codex
  | `String "opencode-v2" -> Ok P.Opencode_v2
  | `String "pi" -> Ok P.Pi
  | _ -> Error "invalid-request"

let digest = function
  | `String value
    when String.length value = 64
         && String.for_all
              (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
              value ->
      Ok value
  | _ -> Error "invalid-request"

let with_store root f =
  let* store = project S.error_code (S.open_ ~root ()) in
  Fun.protect ~finally:(fun () -> ignore (S.close store)) (fun () -> f store)

let policy_json policy = Yojson.Safe.from_string (C.to_string policy)
let registry root = project P.error_code (P.load ~root)

let pair_accounts configured fields =
  let* source_id = id "source_id" fields in
  let* target_id = id "target_id" fields in
  let* () =
    if source_id = target_id then Error "invalid-account-pair" else Ok ()
  in
  let* raw_revision = field "registry_revision" fields in
  let* expected_registry = digest raw_revision in
  let* registry =
    match configured with
    | Some r -> Ok r
    | None -> Error "profiles-unconfigured"
  in
  if expected_registry <> P.registry_revision registry then
    Error "profile-registry-changed"
  else
    let find id =
      match List.find_opt (fun p -> P.id p = id) (P.profiles registry) with
      | Some p -> Ok p
      | None -> Error "unknown-profile"
    in
    let* source = find source_id in
    let* target = find target_id in
    if P.backend source <> P.backend target then
      Error "profile-backend-mismatch"
    else
      let* source =
        project C.error_code
          (C.account ~id:(P.id source)
             ~context_revision:(P.context_revision source))
      in
      let* target =
        project C.error_code
          (C.account ~id:(P.id target)
             ~context_revision:(P.context_revision target))
      in
      Ok (source, target)

let manage root expected change =
  with_store root (fun store ->
      let policy_error = ref None in
      let result =
        S.transaction store ~expected_revision:expected (fun tx ->
            let* policy = S.policy tx in
            match change policy with
            | Error error ->
                policy_error := Some error;
                Error S.Aborted
            | Ok next ->
                let* () = S.set_policy tx next in
                Ok (policy_json next))
      in
      match !policy_error with
      | Some error -> Error (C.error_code error)
      | None -> project S.error_code result)

let handle root raw =
  let* fields =
    match raw with `Assoc fields -> Ok fields | _ -> Error "invalid-request"
  in
  let* version = field "version" fields in
  if version <> `Int 1 then Error "unsupported-request-version"
  else
    let* raw_op = field "op" fields in
    match raw_op with
    | `String "profiles.list" ->
        let* _ = exact [ "version"; "op" ] raw in
        let* configured = registry root in
        Ok
          (`Assoc
             [
               ("configured", `Bool (Option.is_some configured));
               ( "registry_revision",
                 match configured with
                 | None -> `Null
                 | Some r -> `String (P.registry_revision r) );
               ( "profiles",
                 `List
                   (match configured with
                   | None -> []
                   | Some r -> List.map P.public_json (P.profiles r)) );
             ])
    | `String "profiles.resolve" ->
        let* fields =
          exact [ "version"; "op"; "id"; "backend"; "expected_context" ] raw
        in
        let* profile_id = id "id" fields in
        let* raw_backend = field "backend" fields in
        let* backend = parse_backend raw_backend in
        let* raw_expected = field "expected_context" fields in
        let* expected_context =
          match raw_expected with
          | `Null -> Ok None
          | x -> Result.map Option.some (digest x)
        in
        let* configured = registry root in
        let* configured =
          match configured with
          | None -> Error "profiles-unconfigured"
          | Some r -> Ok r
        in
        let* selected =
          project P.error_code
            (P.resolve configured ~id:profile_id ~backend ~expected_context)
        in
        let* () =
          project P.error_code (P.validate_roots ~registry:configured selected)
        in
        (* Host-side only. HTTP callers must use public_json, not forward these roots. *)
        Ok
          (`Assoc
             [
               ("profile", P.public_json selected);
               ( "roots",
                 `Assoc
                   (List.map (fun (k, v) -> (k, `String v)) (P.roots selected))
               );
             ])
    | `String "consent.get" ->
        let* _ = exact [ "version"; "op" ] raw in
        with_store root (fun store ->
            Result.map policy_json (project S.error_code (S.read_policy store)))
    | `String "consent.set_global" ->
        let* fields =
          exact [ "version"; "op"; "expected_revision"; "confirmation" ] raw
        in
        let* expected_revision = revision fields in
        let* confirmation = confirmation fields in
        manage root expected_revision (fun state ->
            C.set_global state ~expected_revision ~confirmation)
    | `String "consent.set_pair" ->
        let* fields =
          exact
            [
              "version";
              "op";
              "expected_revision";
              "source_id";
              "target_id";
              "registry_revision";
              "confirmation";
            ]
            raw
        in
        let* expected_revision = revision fields in
        let* confirmation = confirmation fields in
        let* configured = registry root in
        let* source, target = pair_accounts configured fields in
        manage root expected_revision (fun state ->
            C.set_pair state ~expected_revision ~source ~target ~confirmation)
    | `String "consent.remove_pair" ->
        let* fields =
          exact
            [ "version"; "op"; "expected_revision"; "source_id"; "target_id" ]
            raw
        in
        let* expected_revision = revision fields in
        let* source_id = id "source_id" fields in
        let* target_id = id "target_id" fields in
        if source_id = target_id then Error "invalid-account-pair"
        else
          manage root expected_revision (fun state ->
              C.remove_pair_ids state ~expected_revision ~source_id ~target_id)
    | `String "consent.reset" ->
        let* fields = exact [ "version"; "op"; "expected_revision" ] raw in
        let* expected_revision = revision fields in
        manage root expected_revision (fun state ->
            C.reset state ~expected_revision)
    | `String _ -> Error "unsupported-operation"
    | _ -> Error "invalid-request"

let read_input () =
  let buffer = Buffer.create 1024 and chunk = Bytes.create 8192 in
  let rec loop () =
    let count = input stdin chunk 0 (Bytes.length chunk) in
    if count = 0 then Ok (Buffer.contents buffer)
    else if Buffer.length buffer + count > 131072 then Error "request-too-large"
    else (
      Buffer.add_subbytes buffer chunk 0 count;
      loop ())
  in
  loop ()

let http_operations =
  [
    "profiles.list";
    "consent.get";
    "consent.set_global";
    "consent.set_pair";
    "consent.remove_pair";
    "consent.reset";
  ]

let http_status = function
  | Ok _ -> 200
  | Error "request-too-large" -> 413
  | Error
      ( "consent-revision-conflict" | "profile-registry-changed"
      | "profile-context-changed" | "consent-rule-capacity"
      | "consent-revision-exhausted" ) ->
      409
  | Error ("unknown-profile" | "profiles-unconfigured") -> 404
  | Error
      ( "invalid-request" | "unsupported-request-version"
      | "invalid-account-pair" | "invalid-account-reference"
      | "profile-backend-mismatch" | "unsupported-operation" ) ->
      400
  | Error _ -> 503

let () =
  let selected =
    match Array.to_list Sys.argv with
    | [ _ ] -> Ok None
    | [ _; "--http"; operation ] when List.mem operation http_operations ->
        Ok (Some operation)
    | _ -> Error "unsupported-arguments"
  in
  let is_http = match selected with Ok (Some _) -> true | _ -> false in
  let result =
    try
      let* selected = selected in
      let* bytes = read_input () in
      let* raw =
        try Ok (Yojson.Safe.from_string bytes)
        with Yojson.Json_error _ -> Error "invalid-request"
      in
      let* request =
        match (selected, raw) with
        | None, raw -> Ok raw
        | Some operation, `Assoc fields
          when not
                 (List.mem_assoc "op" fields || List.mem_assoc "version" fields)
          ->
            Ok
              (`Assoc
                 (("version", `Int 1) :: ("op", `String operation) :: fields))
        | _ -> Error "invalid-request"
      in
      let* root =
        project
          (fun _ -> "unsafe-configuration-root")
          (Mesh_paths.conf_dir Sys.getenv_opt)
      in
      handle root request
    with
    | (Out_of_memory | Stack_overflow) as exn -> raise exn
    | _ -> Error "backend-helper-unavailable"
  in
  let response, code =
    match result with
    | Ok data ->
        (`Assoc [ ("version", `Int 1); ("ok", `Bool true); ("data", data) ], 0)
    | Error error ->
        ( `Assoc
            [
              ("version", `Int 1); ("ok", `Bool false); ("code", `String error);
            ],
          1 )
  in
  let response =
    match response with
    | `Assoc fields when is_http ->
        `Assoc (("http_status", `Int (http_status result)) :: fields)
    | response -> response
  in
  print_endline (Yojson.Safe.to_string response);
  exit code
