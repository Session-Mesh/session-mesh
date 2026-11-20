(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

type backend = Claude | Codex | Opencode_v2 | Pi

type error =
  | Invalid_config
  | Unknown_profile
  | Disabled_profile
  | Backend_mismatch
  | Context_changed
  | Unsafe_roots

type t = {
  id : string;
  label : string;
  backend : backend;
  enabled : bool;
  roots : (string * string) list;
  context_revision : string;
}

type registry = { profiles : t list; revision : string }

let ( let* ) = Result.bind

let error_code = function
  | Invalid_config -> "invalid-profile-config"
  | Unknown_profile -> "unknown-profile"
  | Disabled_profile -> "disabled-profile"
  | Backend_mismatch -> "profile-backend-mismatch"
  | Context_changed -> "profile-context-changed"
  | Unsafe_roots -> "unsafe-profile-roots"

let valid_id = Mesh_accounts.valid_id
let hash text = Digestif.SHA256.(to_hex (digest_string text))

let tag = function
  | Claude -> "claude"
  | Codex -> "codex"
  | Opencode_v2 -> "opencode-v2"
  | Pi -> "pi"

let parse_backend = function
  | `String "claude" -> Ok Claude
  | `String "codex" -> Ok Codex
  | `String "opencode-v2" -> Ok Opencode_v2
  | `String "pi" -> Ok Pi
  | _ -> Error Invalid_config

let keys names = function
  | `Assoc fields
    when List.length fields = List.length names
         && List.sort_uniq String.compare (List.map fst fields)
            = List.sort String.compare names ->
      Ok fields
  | _ -> Error Invalid_config

let field name fields =
  match List.assoc_opt name fields with
  | Some x -> Ok x
  | None -> Error Invalid_config

let safe_text text =
  let rec loop offset =
    if offset = String.length text then true
    else
      let decoded = String.get_utf_8_uchar text offset in
      if not (Uchar.utf_decode_is_valid decoded) then false
      else
        let scalar = Uchar.to_int (Uchar.utf_decode_uchar decoded) in
        scalar >= 32
        && (not (scalar >= 127 && scalar <= 159))
        && scalar <> 0x2028 && scalar <> 0x2029
        && loop (offset + Uchar.utf_decode_length decoded)
  in
  loop 0

let text max = function
  | `String text when String.length text <= max && safe_text text -> Ok text
  | _ -> Error Invalid_config

let absolute text =
  (not (Filename.is_relative text))
  && String.length text > 1
  &&
  match String.split_on_char '/' text with
  | "" :: parts ->
      List.for_all (fun part -> part <> "" && part <> "." && part <> "..") parts
  | _ -> false

let root_names = function
  | Claude | Pi -> [ "config"; "history" ]
  | Codex -> [ "config"; "state" ]
  | Opencode_v2 -> [ "config"; "data"; "state"; "cache" ]

let decode_roots backend value =
  let* fields = keys (root_names backend) value in
  let rec loop acc = function
    | [] -> Ok (List.sort (fun (a, _) (b, _) -> String.compare a b) acc)
    | (key, value) :: rest ->
        let* value = text 4096 value in
        if not (Mesh_accounts.valid_path value) then Error Invalid_config
        else loop ((key, value) :: acc) rest
  in
  loop [] fields

let conversation_role = function
  | Claude | Pi -> Some "history"
  | Codex -> Some "state"
  | Opencode_v2 -> None

let separate_conversation_root backend roots =
  match (conversation_role backend, List.assoc_opt "config" roots) with
  | Some role, Some config -> (
      match List.assoc_opt role roots with
      | Some history ->
          history <> config
          && not (String.starts_with ~prefix:(history ^ "/") config)
      | None -> false)
  | None, _ -> true
  | _, None -> false

let decode value =
  let* fields = keys [ "id"; "label"; "backend"; "enabled"; "roots" ] value in
  let* raw_id = field "id" fields in
  let* id = text 80 raw_id in
  let* raw_label = field "label" fields in
  let* label = text 160 raw_label in
  let* raw_backend = field "backend" fields in
  let* backend = parse_backend raw_backend in
  let* raw_enabled = field "enabled" fields in
  let* enabled =
    match raw_enabled with `Bool b -> Ok b | _ -> Error Invalid_config
  in
  let* raw_roots = field "roots" fields in
  let* roots = decode_roots backend raw_roots in
  if
    (not (valid_id id))
    || String.trim label = ""
    || not (separate_conversation_root backend roots)
  then Error Invalid_config
  else
    let context_revision =
      hash
        (Yojson.Safe.to_string
           (`Assoc
              [
                ("backend", `String (tag backend));
                ( "roots",
                  `Assoc
                    (List.map (fun (key, value) -> (key, `String value)) roots)
                );
              ]))
    in
    Ok { id; label; backend; enabled; roots; context_revision }

let overlaps a b =
  a = b
  || String.starts_with ~prefix:(a ^ "/") b
  || String.starts_with ~prefix:(b ^ "/") a

let credential_roots profile =
  List.filter
    (fun (name, _) ->
      name = "config"
      || (profile.backend = Opencode_v2 && (name = "data" || name = "state")))
    profile.roots

let aliases a b =
  let shared_subtree owner other role path credential =
    owner.backend = other.backend
    && conversation_role owner.backend = Some role
    && List.assoc_opt role owner.roots = Some path
    && String.starts_with ~prefix:(credential ^ "/") path
  in
  let check owner other =
    List.exists
      (fun (_, p) ->
        List.exists
          (fun (role, q) ->
            overlaps p q && not (shared_subtree owner other role q p))
          other.roots)
      (credential_roots owner)
  in
  check a b || check b a

let of_json revision value =
  let* fields = keys [ "version"; "profiles" ] value in
  let* version = field "version" fields in
  if version <> `Int 1 then Error Invalid_config
  else
    let* raw = field "profiles" fields in
    let* rows =
      match raw with
      | `List xs when List.length xs <= 64 -> Ok xs
      | _ -> Error Invalid_config
    in
    let rec loop acc = function
      | [] -> Ok { profiles = List.rev acc; revision }
      | raw :: rest ->
          let* profile = decode raw in
          if
            List.exists
              (fun p ->
                p.backend = profile.backend
                && (p.id = profile.id
                   || String.lowercase_ascii p.label
                      = String.lowercase_ascii profile.label)
                || aliases p profile)
              acc
          then Error Invalid_config
          else loop (profile :: acc) rest
    in
    loop [] rows

let of_string bytes =
  if String.length bytes > 1048576 then Error Invalid_config
  else
    try of_json (hash bytes) (Yojson.Safe.from_string bytes)
    with Yojson.Json_error _ -> Error Invalid_config

let profiles registry = registry.profiles
let registry_revision registry = registry.revision
let id p = p.id
let label p = p.label
let backend p = p.backend
let enabled p = p.enabled
let context_revision p = p.context_revision
let roots p = p.roots

let public_json p =
  `Assoc
    [
      ("id", `String p.id);
      ("label", `String p.label);
      ("backend", `String (tag p.backend));
      ("enabled", `Bool p.enabled);
      ("context_revision", `String p.context_revision);
      ("switch_qualified", `Bool false);
    ]

let resolve registry ~id ~backend ~expected_context =
  match
    List.find_opt (fun p -> p.id = id && p.backend = backend) registry.profiles
  with
  | None ->
      if List.exists (fun p -> p.id = id) registry.profiles then
        Error Backend_mismatch
      else Error Unknown_profile
  | Some p when not p.enabled -> Error Disabled_profile
  | Some p
    when Option.fold ~none:false
           ~some:(fun expected -> expected <> p.context_revision)
           expected_context ->
      Error Context_changed
  | Some p -> Ok p

let rec trusted path =
  let st = Unix.lstat path in
  st.Unix.st_kind = Unix.S_DIR
  && List.mem st.Unix.st_uid [ 0; Unix.geteuid () ]
  && (st.Unix.st_perm land 0o022 = 0
     || (st.Unix.st_uid = 0 && st.Unix.st_perm land 0o1000 <> 0))
  && (Filename.dirname path = path || trusted (Filename.dirname path))

let validate_roots ?registry profile =
  try
    if
      List.for_all
        (fun (_, path) ->
          let st = Unix.lstat path in
          st.Unix.st_kind = Unix.S_DIR
          && st.Unix.st_uid = Unix.geteuid ()
          && st.Unix.st_perm land 0o022 = 0
          && Unix.realpath path = path
          && trusted (Filename.dirname path))
        profile.roots
    then
      let identities =
        List.map (fun (role, path) -> (role, Unix.stat path)) profile.roots
      in
      let same a b =
        a.Unix.st_dev = b.Unix.st_dev && a.Unix.st_ino = b.Unix.st_ino
      in
      let own_alias =
        match
          (conversation_role profile.backend, List.assoc_opt "config" identities)
        with
        | Some role, Some config -> (
            match List.assoc_opt role identities with
            | Some history -> same config history
            | None -> true)
        | _ -> false
      in
      let credential p role = List.mem_assoc role (credential_roots p) in
      let peer_alias =
        match registry with
        | None -> false
        | Some registry ->
            List.exists
              (fun other ->
                (other.id <> profile.id || other.backend <> profile.backend)
                && List.exists
                     (fun (role, path) ->
                       match Unix.stat path with
                       | peer ->
                           List.exists
                             (fun (own_role, own) ->
                               same own peer
                               && (credential profile own_role
                                  || credential other role))
                             identities
                       | exception Unix.Unix_error _ -> false)
                     other.roots)
              registry.profiles
      in
      if own_alias || peer_alias then Error Unsafe_roots else Ok ()
    else Error Unsafe_roots
  with Unix.Unix_error _ | Sys_error _ -> Error Unsafe_roots

let validate_private_root root =
  if (not (absolute root)) || not (safe_text root) then Error Unsafe_roots
  else
    try
      let st = Unix.lstat root in
      if
        Unix.realpath root <> root
        || st.Unix.st_kind <> Unix.S_DIR
        || st.Unix.st_uid <> Unix.geteuid ()
        || st.Unix.st_perm land 0o077 <> 0
        || not (trusted (Filename.dirname root))
      then Error Unsafe_roots
      else Ok ()
    with Unix.Unix_error _ | Sys_error _ -> Error Unsafe_roots

let private_config st =
  st.Unix.st_kind = Unix.S_REG
  && st.Unix.st_uid = Unix.geteuid ()
  && st.Unix.st_perm land 0o077 = 0
  && st.Unix.st_nlink = 1

let load ~root =
  let* () = validate_private_root root in
  let path = Filename.concat root "backend-profiles.json" in
  try
    match Unix.lstat path with
    | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok None
    | initial when not (private_config initial) -> Error Unsafe_roots
    | initial when initial.Unix.st_size > 1048576 -> Error Invalid_config
    | initial ->
        let fd = Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
        Fun.protect
          ~finally:(fun () -> Unix.close fd)
          (fun () ->
            let actual = Unix.fstat fd in
            if
              (not (private_config actual))
              || actual.Unix.st_size > 1048576
              || actual.Unix.st_dev <> initial.Unix.st_dev
              || actual.Unix.st_ino <> initial.Unix.st_ino
            then Error Unsafe_roots
            else
              let buffer = Buffer.create actual.Unix.st_size
              and chunk = Bytes.create 8192 in
              let rec read () =
                let count = Unix.read fd chunk 0 (Bytes.length chunk) in
                if count = 0 then
                  Result.map Option.some (of_string (Buffer.contents buffer))
                else if Buffer.length buffer + count > 1048576 then
                  Error Invalid_config
                else (
                  Buffer.add_subbytes buffer chunk 0 count;
                  read ())
              in
              read ())
  with Unix.Unix_error _ | Sys_error _ -> Error Unsafe_roots
