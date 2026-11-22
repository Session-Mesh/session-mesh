(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

module A = Mesh_accounts
module P = Mesh_backend_profile

type error =
  | Unsafe_configuration_root
  | Source_missing
  | Unsafe_source
  | Invalid_source
  | Invalid_profiles
  | Profile_name_collision
  | Derived_root_too_long
  | Profile_compatibility_limit
  | Unsafe_agent_roots
  | Target_exists
  | Already_retired
  | Publication_failed
  | Publication_uncertain

type report = { aliases : int; profiles : int }

let ( let* ) = Result.bind
let project error = Result.map_error (fun _ -> error)

let error_code = function
  | Unsafe_configuration_root -> "migration-unsafe-configuration-root"
  | Source_missing -> "migration-source-missing"
  | Unsafe_source -> "migration-unsafe-source"
  | Invalid_source -> "migration-invalid-source"
  | Invalid_profiles -> "migration-invalid-profiles"
  | Profile_name_collision -> "migration-profile-name-collision"
  | Derived_root_too_long -> "migration-derived-root-too-long"
  | Profile_compatibility_limit -> "migration-profile-compatibility-limit"
  | Unsafe_agent_roots -> "migration-unsafe-agent-roots"
  | Target_exists -> "migration-target-exists"
  | Already_retired -> "migration-already-retired"
  | Publication_failed -> "migration-publication-failed"
  | Publication_uncertain -> "migration-publication-uncertain"

let source root = Filename.concat root "accounts.json"
let target root = Filename.concat root "backend-profiles.json"
let marker root = Filename.concat root "backend-profiles.migrated"
let same a b = a.Unix.st_dev = b.Unix.st_dev && a.Unix.st_ino = b.Unix.st_ino

let private_file st =
  st.Unix.st_kind = Unix.S_REG
  && st.Unix.st_uid = Unix.geteuid ()
  && st.Unix.st_perm land 0o077 = 0
  && st.Unix.st_nlink = 1

let unchanged a b =
  private_file b && same a b
  && a.Unix.st_size = b.Unix.st_size
  && a.Unix.st_mtime = b.Unix.st_mtime
  && a.Unix.st_ctime = b.Unix.st_ctime

let absent ?(error = Target_exists) path =
  match Unix.lstat path with
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok ()
  | _ -> Error error

let available root =
  let* () = absent (target root) in
  match absent ~error:Already_retired (marker root) with
  | Ok () -> Ok ()
  | Error error ->
      (* A concurrent successful writer publishes the registry before its
         marker. Preserve target-exists precedence if it won between checks. *)
      let* () = absent (target root) in
      Error error

(* Match the native profile loader's private-file custody and descriptor identity
   checks, but delegate the legacy grammar to the existing alias parser. *)
let read_source root =
  try
    let path = source root in
    match Unix.lstat path with
    | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Error Source_missing
    | initial when not (private_file initial) -> Error Unsafe_source
    | initial when initial.Unix.st_size > A.max_bytes -> Error Invalid_source
    | initial ->
        let fd = Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
        Fun.protect
          ~finally:(fun () -> Unix.close fd)
          (fun () ->
            let actual = Unix.fstat fd in
            if not (unchanged initial actual) then Error Unsafe_source
            else
              let buffer = Buffer.create actual.Unix.st_size
              and chunk = Bytes.create 8192 in
              let rec read () =
                let count = Unix.read fd chunk 0 (Bytes.length chunk) in
                if count = 0 then
                  if
                    unchanged actual (Unix.fstat fd)
                    && unchanged actual (Unix.lstat path)
                  then Ok (Buffer.contents buffer, actual)
                  else Error Unsafe_source
                else if Buffer.length buffer + count > A.max_bytes then
                  Error Invalid_source
                else (
                  Buffer.add_subbytes buffer chunk 0 count;
                  read ())
              in
              read ())
  with Unix.Unix_error _ | Sys_error _ -> Error Unsafe_source

let convert bytes =
  let* accounts = project Invalid_source (A.parse bytes) in
  let* () =
    if
      List.exists
        (fun (account : A.account) ->
          List.exists
            (fun (base, suffix) ->
              Option.fold ~none:false
                ~some:(fun path ->
                  not (A.valid_path (Filename.concat path suffix)))
                base)
            [
              (account.claude_config_dir, "projects");
              (account.codex_home, "sessions");
            ])
        accounts
    then Error Derived_root_too_long
    else Ok ()
  in
  let entry (account : A.account) backend config role suffix =
    `Assoc
      [
        ("id", `String account.id);
        ("label", `String (String.trim account.label));
        ("backend", `String backend);
        ("enabled", `Bool true);
        ( "roots",
          `Assoc
            [
              ("config", `String config);
              (role, `String (Filename.concat config suffix));
            ] );
      ]
  in
  let profiles =
    List.concat_map
      (fun (account : A.account) ->
        Option.fold ~none:[]
          ~some:(fun config ->
            [ entry account "claude" config "history" "projects" ])
          account.claude_config_dir
        @ Option.fold ~none:[]
            ~some:(fun config ->
              [ entry account "codex" config "state" "sessions" ])
            account.codex_home)
      accounts
  in
  (* Each of the 64 legacy aliases can declare both supported backends. *)
  if List.length profiles > 128 then Error Profile_compatibility_limit
  else
    let content =
      Yojson.Safe.to_string
        (`Assoc [ ("version", `Int 1); ("profiles", `List profiles) ])
      ^ "\n"
    in
    let* registry = project Invalid_profiles (P.of_string content) in
    let has_backend (account : A.account) backend =
      match backend with
      | `Claude -> Option.is_some account.claude_config_dir
      | `Codex -> Option.is_some account.codex_home
    in
    let* () =
      if
        List.exists
          (fun (account : A.account) ->
            let original = String.lowercase_ascii account.label in
            let trimmed = String.lowercase_ascii (String.trim account.label) in
            trimmed <> original
            && (trimmed = "default"
               || List.exists
                    (fun (other : A.account) ->
                      account.id <> other.id && trimmed = other.id
                      && List.exists
                           (fun backend ->
                             has_backend account backend
                             && has_backend other backend)
                           [ `Claude; `Codex ])
                    accounts))
          accounts
      then Error Profile_name_collision
      else Ok ()
    in
    Ok
      ( content,
        registry,
        { aliases = List.length accounts; profiles = List.length profiles } )

let rec trusted path =
  let st = Unix.lstat path in
  Result.is_ok (A.trusted_ancestor ~uid:(Unix.geteuid ()) path st)
  && (st.Unix.st_perm land 0o022 = 0
     || (st.Unix.st_uid = 0 && st.Unix.st_perm land 0o1000 <> 0))
  && (Filename.dirname path = path || trusted (Filename.dirname path))

(* Missing config roots are valid legacy declarations. A missing conventional
   child beneath one is also allowed; neither is prepared during migration. *)
let check_roots registry =
  try
    let rec check_profiles identities = function
      | [] -> Ok identities
      | profile :: rest ->
          let config = List.assoc "config" (P.roots profile) in
          let config_missing =
            match Unix.lstat config with
            | exception Unix.Unix_error (Unix.ENOENT, _, _) -> true
            | _ -> false
          in
          let* () =
            if
              List.for_all
                (fun (_, path) -> Sys.file_exists path)
                (P.roots profile)
            then project Unsafe_agent_roots (P.validate_roots ~registry profile)
            else Ok ()
          in
          let rec check_paths identities = function
            | [] -> check_profiles identities rest
            | (role, path) :: paths -> (
                if config_missing && role <> "config" then
                  check_paths identities paths
                else
                  let* () =
                    project Unsafe_agent_roots
                      (A.check_directory ~uid:(Unix.geteuid ()) path)
                  in
                  match Unix.lstat path with
                  | exception Unix.Unix_error (Unix.ENOENT, _, _) ->
                      if trusted (Filename.dirname path) then
                        check_paths identities paths
                      else Error Unsafe_agent_roots
                  | st ->
                      if
                        Unix.realpath path <> path
                        || not (trusted (Filename.dirname path))
                      then Error Unsafe_agent_roots
                      else if
                        List.exists
                          (fun (other_role, other) ->
                            same st other
                            && (role = "config" || other_role = "config"))
                          identities
                      then Error Unsafe_agent_roots
                      else check_paths ((role, st) :: identities) paths)
          in
          check_paths identities (P.roots profile)
    in
    Result.map (fun _ -> ()) (check_profiles [] (P.profiles registry))
  with Unix.Unix_error _ | Sys_error _ -> Error Unsafe_agent_roots

let create_temp root =
  let random = Random.State.make_self_init () in
  let rec attempt remaining =
    let path =
      Filename.concat root
        (Printf.sprintf ".backend-profiles-%d-%08x.tmp" (Unix.getpid ())
           (Random.State.bits random))
    in
    match
      Unix.openfile path
        [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
        0o600
    with
    | fd -> (path, fd)
    | exception Unix.Unix_error (Unix.EEXIST, _, _) when remaining > 1 ->
        attempt (remaining - 1)
  in
  attempt 16

let rec write_all fd bytes offset =
  if offset < String.length bytes then
    let count =
      Unix.write_substring fd bytes offset (String.length bytes - offset)
    in
    if count = 0 then raise (Unix.Unix_error (Unix.EIO, "write", ""))
    else write_all fd bytes (offset + count)

let cleanup_temp path identity =
  try if same identity (Unix.lstat path) then Unix.unlink path
  with Unix.Unix_error _ -> ()

let stage_name name =
  let prefix = ".backend-profiles-" and suffix = ".tmp" in
  if
    not (String.starts_with ~prefix name && String.ends_with ~suffix name)
  then false
  else
    let middle =
      String.sub name (String.length prefix)
        (String.length name - String.length prefix - String.length suffix)
    in
    match String.split_on_char '-' middle with
    | [ pid; hex ] ->
        pid <> ""
        && String.for_all (function '0' .. '9' -> true | _ -> false) pid
        && String.length hex = 8
        && String.for_all
             (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
             hex
    | _ -> false

(* Only the one recognized staging hard link in the same private root may be
   removed. The expected bytes and descriptor identity must still match the
   current source conversion; arbitrary same-user files are never unlinked. *)
let recover_link ~root ~directory ~before_publish content =
  try
    let destination = target root in
    let initial = Unix.lstat destination in
    if
      initial.Unix.st_kind <> Unix.S_REG
      || initial.Unix.st_uid <> Unix.geteuid ()
      || initial.Unix.st_perm land 0o077 <> 0
      || initial.Unix.st_nlink <> 2
      || initial.Unix.st_size <> String.length content
    then Error Target_exists
    else
      let stages =
        Array.to_list (Sys.readdir root)
        |> List.filter stage_name
        |> List.filter (fun name ->
               try same initial (Unix.lstat (Filename.concat root name))
               with Unix.Unix_error _ -> false)
      in
      match stages with
      | [ name ] ->
          let stage = Filename.concat root name in
          let fd =
            Unix.openfile destination [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0
          in
          let matches =
            Fun.protect
              ~finally:(fun () -> Unix.close fd)
              (fun () ->
                let bytes = Bytes.create (String.length content) in
                let rec read offset =
                  if offset = Bytes.length bytes then true
                  else
                    let count =
                      Unix.read fd bytes offset (Bytes.length bytes - offset)
                    in
                    count > 0 && read (offset + count)
                in
                same initial (Unix.fstat fd)
                && read 0 && Bytes.to_string bytes = content
                && same initial (Unix.fstat fd))
          in
          if not matches then Error Target_exists
          else
            let* () = before_publish () in
            let current = Unix.lstat destination in
            if
              not (same initial current && current.Unix.st_nlink = 2)
              || not (same initial (Unix.lstat stage))
              || (Unix.lstat stage).Unix.st_nlink <> 2
            then Error Target_exists
            else (
              Unix.unlink stage;
              Unix.fsync directory;
              if private_file (Unix.lstat destination) then Ok ()
              else Error Publication_uncertain)
      | _ -> Error Target_exists
  with Unix.Unix_error _ | Sys_error _ -> Error Publication_uncertain

(* [before_publish] performs the last custody revalidation. As in the native
   project store, staged bytes are fsynced before that boundary. Unlike rename,
   link never overwrites an existing target, including a concurrent winner. *)
let publish_file ~root ~directory ~destination ~exists ~before_publish content =
  let linked = ref false in
  try
    let path, fd = create_temp root in
    let identity = Unix.fstat fd in
    Fun.protect
      ~finally:(fun () -> cleanup_temp path identity)
      (fun () ->
        Fun.protect
          ~finally:(fun () -> Unix.close fd)
          (fun () ->
            write_all fd content 0;
            Unix.fchmod fd 0o600;
            Unix.fsync fd);
        let* () = before_publish () in
        let current = Unix.lstat path in
        if not (private_file current && same identity current) then
          Error Publication_failed
        else
          match Unix.link path destination with
          | exception Unix.Unix_error (Unix.EEXIST, _, _) -> Error exists
          | () ->
              linked := true;
              Unix.unlink path;
              let final = Unix.lstat destination in
              if not (private_file final && same identity final) then
                Error Publication_uncertain
              else (
                Unix.fsync directory;
                Ok ()))
  with Unix.Unix_error _ | Sys_error _ ->
    Error (if !linked then Publication_uncertain else Publication_failed)

let publish_marker ~root ~directory ~before_publish content =
  let* registry = project Invalid_profiles (P.of_string content) in
  let marker_content =
    Yojson.Safe.to_string
      (`Assoc
         [
           ("version", `Int 1);
           ("registry_revision", `String (P.registry_revision registry));
         ])
    ^ "\n"
  in
  (* These are two separate publications, not a two-file transaction. *)
  try
    project Publication_uncertain
      (publish_file ~root ~directory ~destination:(marker root)
         ~exists:Already_retired ~before_publish marker_content)
  with
  | (Out_of_memory | Stack_overflow) as exn -> raise exn
  | _ -> Error Publication_uncertain

let publish ~root ~directory ~before_publish content =
  let* () = available root in
  let* () =
    publish_file ~root ~directory ~destination:(target root)
      ~exists:Target_exists
      ~before_publish:(fun () ->
        let* () = before_publish () in
        available root)
      content
  in
  publish_marker ~root ~directory ~before_publish content

let migrate ~root =
  let* () = project Unsafe_configuration_root (P.validate_private_root root) in
  try
    let initial_root = Unix.lstat root in
    let directory = Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
    Fun.protect
      ~finally:(fun () -> Unix.close directory)
      (fun () ->
        let recheck_root () =
          let* () =
            project Unsafe_configuration_root (P.validate_private_root root)
          in
          if
            same initial_root (Unix.fstat directory)
            && same initial_root (Unix.lstat root)
          then Ok ()
          else Error Unsafe_configuration_root
        in
        let* () = recheck_root () in
        let existing =
          match Unix.lstat (target root) with
          | exception Unix.Unix_error (Unix.ENOENT, _, _) -> None
          | st -> Some st
        in
        let* () =
          match existing with
          | Some st when st.Unix.st_nlink <> 2 -> Error Target_exists
          | Some _ ->
              (match absent (marker root) with
              | Ok () -> Ok ()
              | Error _ -> Error Target_exists)
          | None -> absent ~error:Already_retired (marker root)
        in
        let* bytes, source_identity = read_source root in
        let* content, registry, report = convert bytes in
        let* () = check_roots registry in
        let before_publish () =
          let* () = recheck_root () in
          let* () =
            if unchanged source_identity (Unix.lstat (source root)) then Ok ()
            else Error Unsafe_source
          in
          check_roots registry
        in
        let* () =
          if Option.is_some existing then (
            let* () = recover_link ~root ~directory ~before_publish content in
            publish_marker ~root ~directory ~before_publish content)
          else publish ~root ~directory ~before_publish content
        in
        Ok report)
  with Unix.Unix_error _ | Sys_error _ -> Error Publication_failed
