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
  | Migration_busy
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
  | Migration_busy -> "migration-busy"
  | Publication_failed -> "migration-publication-failed"
  | Publication_uncertain -> "migration-publication-uncertain"

let source root = Filename.concat root "accounts.json"
let target root = Filename.concat root "backend-profiles.json"
let marker root = Filename.concat root "backend-profiles.migrated"
let intent root = Filename.concat root ".backend-profiles.migration-intent"
let first_intent root = Filename.concat root ".backend-profiles.create-intent"
let provision_intent root = Filename.concat root ".backend-profiles.provision-intent"
let migration_lock root = Filename.concat root ".backend-profiles.lock"
(* A legacy switch records its uncertain outcome durably under this same
   lock. Never interpret or remove its evidence on behalf of the operator. *)
let legacy_switch_marker root = Filename.concat root ".backend-profiles.legacy-switch"
let hash bytes = Digestif.SHA256.(to_hex (digest_string bytes))
let receipt_prefix = ".backend-profiles.provision-receipt-"
let provision_receipt root proof = Filename.concat root (receipt_prefix ^ hash proof)
let same a b = a.Unix.st_dev = b.Unix.st_dev && a.Unix.st_ino = b.Unix.st_ino

let private_file st =
  st.Unix.st_kind = Unix.S_REG
  && st.Unix.st_uid = Unix.geteuid ()
  && st.Unix.st_perm land 0o077 = 0
  && st.Unix.st_nlink = 1

(* POSIX record locks are process-scoped. The host-only CLI performs one
   migration per process; callers must not run two migrations from one process.
   Never unlink this file: a waiting opener could otherwise lock a stale inode
   while a newcomer locks its replacement. *)
let acquire_migration_lock root =
  let path = migration_lock root in
  try
    let open_existing () =
      Unix.openfile path [ Unix.O_RDWR; Unix.O_CLOEXEC ] 0
    in
    let fd =
      match Unix.lstat path with
      | st when private_file st -> open_existing ()
      | _ -> raise (Unix.Unix_error (Unix.EPERM, "migration lock", path))
      | exception Unix.Unix_error (Unix.ENOENT, _, _) ->
          (try
             Unix.openfile path
               [ Unix.O_RDWR; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
               0o600
           with Unix.Unix_error (Unix.EEXIST, _, _) -> open_existing ())
    in
    let validate () =
      let opened = Unix.fstat fd in
      let named = Unix.lstat path in
      private_file opened && private_file named
      && opened.Unix.st_perm land 0o777 = 0o600
      && named.Unix.st_perm land 0o777 = 0o600
      && same opened named
    in
    let result =
      try
        if not (validate ()) then Error Unsafe_configuration_root
        else
          match Unix.lockf fd Unix.F_TLOCK 0 with
          | () ->
              if validate () then Ok fd else Error Unsafe_configuration_root
          | exception Unix.Unix_error ((Unix.EAGAIN | Unix.EACCES), _, _) ->
              Error Migration_busy
      with Unix.Unix_error _ -> Error Unsafe_configuration_root
    in
    (match result with Ok _ -> () | Error _ -> Unix.close fd);
    result
  with Unix.Unix_error _ -> Error Unsafe_configuration_root

let with_migration_lock ~root f =
  let* fd = acquire_migration_lock root in
  Fun.protect ~finally:(fun () -> Unix.close fd) f

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

let random_hex () =
    let fd = Unix.openfile "/dev/urandom" [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
    Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
        let bytes = Bytes.create 8 in
        let rec fill offset =
          if offset < 8 then
            let count = Unix.read fd bytes offset (8 - offset) in
            if count = 0 then raise (Unix.Unix_error (Unix.EIO, "read", ""))
            else fill (offset + count)
        in
        fill 0;
        String.concat ""
          (List.init 8 (fun i ->
               Printf.sprintf "%02x" (Char.code (Bytes.get bytes i)))))

let create_temp root =
  let rec attempt remaining =
    let path =
      Filename.concat root
        (Printf.sprintf ".backend-profiles-%d-%s.tmp" (Unix.getpid ())
           (random_hex ()))
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

let intent_bytes ~stage ~source_identity ~source_bytes ~target_identity content =
  Yojson.Safe.to_string
    (`Assoc
      [
        ("version", `Int 1);
        ("stage", `String (Filename.basename stage));
        ("source_dev", `Int source_identity.Unix.st_dev);
        ("source_ino", `Int source_identity.Unix.st_ino);
        ("source_size", `Int source_identity.Unix.st_size);
        ("source_digest", `String (hash source_bytes));
        ("target_dev", `Int target_identity.Unix.st_dev);
        ("target_ino", `Int target_identity.Unix.st_ino);
        ("target_digest", `String (hash content));
      ])
  ^ "\n"

let write_intent ~root ~directory bytes =
  let path = intent root in
  let fd =
    Unix.openfile path
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ] 0o600
  in
  let identity = Unix.fstat fd in
  (try
     Fun.protect
       ~finally:(fun () -> Unix.close fd)
       (fun () ->
         write_all fd bytes 0;
         Unix.fchmod fd 0o600;
         Unix.fsync fd);
     Unix.fsync directory;
     identity
   with exn ->
     cleanup_temp path identity;
     raise exn)

let read_intent root =
  try
    let path = intent root in
    let initial = Unix.lstat path in
    if not (private_file initial) || initial.Unix.st_size > 1024 then None
    else
      let fd = Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect
        ~finally:(fun () -> Unix.close fd)
        (fun () ->
          if not (unchanged initial (Unix.fstat fd)) then None
          else
            let bytes = Bytes.create initial.Unix.st_size in
            let rec read offset =
              if offset = Bytes.length bytes then true
              else
                let n = Unix.read fd bytes offset (Bytes.length bytes - offset) in
                n > 0 && read (offset + n)
            in
            if
              read 0 && unchanged initial (Unix.fstat fd)
              && unchanged initial (Unix.lstat path)
            then Some (initial, Bytes.to_string bytes)
            else None)
  with Unix.Unix_error _ -> None

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
        && String.length hex = 16
        && String.for_all
             (function '0' .. '9' | 'a' .. 'f' -> true | _ -> false)
             hex
    | _ -> false

(* Only the staging hard link named by a durable migration intent may be
   removed; a matching same-user name, inode and payload alone prove nothing. *)
let recover_link ~root ~directory ~before_publish ~source_identity ~source_bytes
    content =
  try
    let destination = target root in
    let initial = Unix.lstat destination in
    let record = read_intent root in
    if
      initial.Unix.st_kind <> Unix.S_REG
      || initial.Unix.st_uid <> Unix.geteuid ()
      || initial.Unix.st_perm land 0o077 <> 0
      || not (initial.Unix.st_nlink = 1 || initial.Unix.st_nlink = 2)
      || initial.Unix.st_size <> String.length content
    then Error Target_exists
    else
      match record with
      | Some (record_identity, bytes) ->
          let stages =
            Array.to_list (Sys.readdir root)
            |> List.filter stage_name
            |> List.filter (fun name ->
                   try same initial (Unix.lstat (Filename.concat root name))
                   with Unix.Unix_error _ -> false)
          in
          let matching =
            List.filter
              (fun name ->
                bytes
                = intent_bytes ~stage:(Filename.concat root name)
                    ~source_identity ~source_bytes ~target_identity:initial
                    content)
              stages
          in
          let recorded_stage =
            match matching with
            | [ name ]
              when initial.Unix.st_nlink = 2 && List.length stages = 1 ->
                Some name
            | [] when initial.Unix.st_nlink = 1 ->
                (* The stage was unlinked before the process died. Recover only
                   the exact recorded stage, not a matching unrelated file. *)
                (try
                   let json = Yojson.Safe.from_string bytes in
                   match Yojson.Safe.Util.member "stage" json with
                   | `String name
                     when stage_name name
                          && (match Unix.lstat (Filename.concat root name) with
                             | exception Unix.Unix_error (Unix.ENOENT, _, _) ->
                                 true
                             | _ -> false)
                          && bytes
                             = intent_bytes
                                 ~stage:(Filename.concat root name)
                                 ~source_identity ~source_bytes
                                 ~target_identity:initial content ->
                       Some name
                   | _ -> None
                 with Yojson.Json_error _ -> None)
            | _ -> None
          in
          (match recorded_stage with
          | None -> Error Target_exists
          | Some name ->
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
                  not
                    (same initial current
                    && current.Unix.st_nlink = initial.Unix.st_nlink)
                  || (match read_intent root with
                     | Some (current_record, current_bytes) ->
                         not
                           (same record_identity current_record
                           && private_file current_record
                           && current_bytes = bytes)
                     | None -> true)
                  || (initial.Unix.st_nlink = 2
                     && (not (same initial (Unix.lstat stage))
                        || (Unix.lstat stage).Unix.st_nlink <> 2))
                  || (initial.Unix.st_nlink = 1
                     && (match Unix.lstat stage with
                        | exception Unix.Unix_error (Unix.ENOENT, _, _) -> false
                        | _ -> true))
                then Error Target_exists
                else (
                  if initial.Unix.st_nlink = 2 then Unix.unlink stage;
                  Unix.fsync directory;
                  if
                    private_file (Unix.lstat destination)
                    && same initial (Unix.lstat destination)
                  then Ok ()
                  else Error Publication_uncertain))
      | _ -> Error Target_exists
  with Unix.Unix_error _ | Sys_error _ -> Error Publication_uncertain

(* [before_publish] performs the last custody revalidation. As in the native
   project store, staged bytes are fsynced before that boundary. The exclusive
   move never overwrites an existing target and preserves a single link. *)
let publish_file ?origin ?(after_publish = fun () -> ()) ~root ~directory ~destination ~exists ~before_publish
    content =
  let linked = ref false in
  let record_identity = ref None in
  try
    let path, fd = create_temp root in
    let identity = Unix.fstat fd in
    Fun.protect
      ~finally:(fun () ->
         cleanup_temp path identity;
         if not !linked then
           Option.iter (cleanup_temp (intent root)) !record_identity)
      (fun () ->
        Fun.protect
          ~finally:(fun () -> Unix.close fd)
          (fun () ->
            write_all fd content 0;
            Unix.fchmod fd 0o600;
            Unix.fsync fd);
        (match origin with
        | None -> ()
        | Some (source_identity, source_bytes) ->
            let record =
              intent_bytes ~stage:path ~source_identity ~source_bytes
                ~target_identity:identity content
            in
            record_identity := Some (write_intent ~root ~directory record));
        let* () = before_publish () in
        let current = Unix.lstat path in
        if not (private_file current && same identity current) then
          Error Publication_failed
        else
          match Mesh_accounts_carry.rename_noreplace path destination with
          | exception Unix.Unix_error (Unix.EEXIST, _, _) -> Error exists
          | () ->
              linked := true;
              after_publish ();
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

let publish ?origin ~root ~directory ~before_publish content =
  let* () = available root in
  let* () =
    publish_file ?origin ~root ~directory ~destination:(target root)
      ~exists:Target_exists
      ~before_publish:(fun () ->
        let* () = before_publish () in
        available root)
      content
  in
  publish_marker ~root ~directory ~before_publish content

let finish_intent ~root ~directory ~source_identity ~source_bytes content =
  match read_intent root with
  | None -> Error Publication_uncertain
  | Some (identity, bytes) ->
      (try
         let target_identity = Unix.lstat (target root) in
         let marker_identity = Unix.lstat (marker root) in
         let stage =
           match Yojson.Safe.Util.member "stage" (Yojson.Safe.from_string bytes) with
           | `String name when stage_name name -> Some (Filename.concat root name)
           | _ -> None
         in
         if
           not (same identity (Unix.lstat (intent root)))
           || not (private_file target_identity && private_file marker_identity)
           || not (unchanged source_identity (Unix.lstat (source root)))
           || not
                (Option.fold ~none:false
                   ~some:(fun stage ->
                     bytes
                     = intent_bytes ~stage ~source_identity ~source_bytes
                         ~target_identity content)
                   stage)
         then
           Error Publication_uncertain
         else (
           Unix.unlink (intent root);
           Unix.fsync directory;
           Ok ())
       with Unix.Unix_error _ | Yojson.Json_error _ ->
         Error Publication_uncertain)

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
         with_migration_lock ~root (fun () ->
             let* () = recheck_root () in
             (* Refuse migration while a legacy switch or initial setup is active. *)
             let* () = absent ~error:Migration_busy (legacy_switch_marker root) in
             let* () = absent (first_intent root) in
             let* () = absent ~error:Migration_busy (provision_intent root) in
             let existing =
               match Unix.lstat (target root) with
               | exception Unix.Unix_error (Unix.ENOENT, _, _) -> None
               | st -> Some st
             in
             let* () =
               match existing with
               | Some st when st.Unix.st_nlink <> 1 && st.Unix.st_nlink <> 2 ->
                   Error Target_exists
               | Some _ ->
                   (match absent (marker root) with
                   | Ok () -> Ok ()
                   | Error _ -> Error Target_exists)
               | None ->
                   let* () = absent ~error:Already_retired (marker root) in
                   absent (intent root)
             in
             let* bytes, source_identity = read_source root in
             let* content, registry, report = convert bytes in
             let* () = check_roots registry in
             let before_publish () =
               let* () = recheck_root () in
               let* () =
                 if unchanged source_identity (Unix.lstat (source root)) then
                   Ok ()
                 else Error Unsafe_source
               in
               check_roots registry
             in
             let* () =
               if Option.is_some existing then (
                 let* () =
                   recover_link ~root ~directory ~before_publish ~source_identity
                     ~source_bytes:bytes content
                 in
                 publish_marker ~root ~directory ~before_publish content)
               else
                 publish ~origin:(source_identity, bytes) ~root ~directory
                   ~before_publish content
             in
             let* () =
               finish_intent ~root ~directory ~source_identity
                 ~source_bytes:bytes content
             in
             Ok report))
  with Unix.Unix_error _ | Sys_error _ -> Error Publication_failed

(* First-create intent is deliberately distinct from the legacy migration
   intent: neither operation may interpret or retire the other's evidence. *)

let first_source root =
  match read_source root with
  | Error Source_missing -> `Null
  | Ok (bytes, st) ->
      `Assoc
        [
          ("dev", `Int st.Unix.st_dev);
          ("ino", `Int st.Unix.st_ino);
          ("size", `Int st.Unix.st_size);
          ("digest", `String (hash bytes));
        ]
  | Error _ -> raise (Unix.Unix_error (Unix.EPERM, "source", ""))

let first_intent_bytes ~root ~stage ~identity ~content =
  Yojson.Safe.to_string
    (`Assoc
       [
         ("version", `Int 1);
         ("kind", `String "first-profile-create");
         ("stage", `String (Filename.basename stage));
         ("dev", `Int identity.Unix.st_dev);
         ("ino", `Int identity.Unix.st_ino);
         ("size", `Int (String.length content));
         ("digest", `String (hash content));
         ("source", first_source root);
       ])
  ^ "\n"

let write_first_intent ~root ~directory ~stage ~content =
  let identity = Unix.lstat stage in
  if not (private_file identity) || not (stage_name (Filename.basename stage))
  then raise (Unix.Unix_error (Unix.EPERM, "stage", ""));
  let bytes = first_intent_bytes ~root ~stage ~identity ~content in
  let fd =
    Unix.openfile (first_intent root)
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ] 0o600
  in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
      write_all fd bytes 0;
      Unix.fsync fd);
  Unix.fsync directory

let read_first_intent root =
  let path = first_intent root in
  let initial = Unix.lstat path in
  if not (private_file initial) || initial.Unix.st_size > 1024 then None
  else
    let fd = Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
    Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
        if not (unchanged initial (Unix.fstat fd)) then None
        else
          let bytes = Bytes.create initial.Unix.st_size in
          let rec read offset =
            if offset = Bytes.length bytes then true
            else
              let count =
                Unix.read fd bytes offset (Bytes.length bytes - offset)
              in
              count > 0 && read (offset + count)
          in
          if read 0 && unchanged initial (Unix.fstat fd)
             && unchanged initial (Unix.lstat path)
           then Some (initial, Bytes.to_string bytes)
           else None)

let cleanup_first_stage ~root ~stage ~identity =
  let absent path = match Unix.lstat path with
    | exception Unix.Unix_error (Unix.ENOENT, _, _) -> true | _ -> false in
  if absent (first_intent root) && absent (provision_intent root)
  then cleanup_temp stage identity

type create_recovery = Unpublished_aborted | Published_reconciled

let inspect_provision ~root =
  let fail () = Error "profile-publication-uncertain" in
  try
    let* () = project "unsafe-configuration-root" (P.validate_private_root root) in
    let* lock = Result.map_error error_code (acquire_migration_lock root) in
    Fun.protect ~finally:(fun () -> Unix.close lock) (fun () ->
      let directory = Unix.openfile root [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
        let root_id = Unix.fstat directory in
        let path = provision_intent root in
        let before = Unix.lstat path in
        if not (same root_id (Unix.lstat root) && private_file before && before.Unix.st_size <= 4096)
        then fail () else
        let fd = Unix.openfile path [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
        Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
          let bytes = Bytes.create before.Unix.st_size in
          let rec loop n = if n = Bytes.length bytes then true else
            let count = Unix.read fd bytes n (Bytes.length bytes - n) in
            count > 0 && loop (n + count) in
          if not (unchanged before (Unix.fstat fd) && loop 0 && unchanged before (Unix.fstat fd)
                  && unchanged before (Unix.lstat path) && same root_id (Unix.lstat root)) then fail ()
          else Ok (Printf.sprintf "%d:%d:%d:%d:%s" root_id.Unix.st_dev root_id.Unix.st_ino
            before.Unix.st_dev before.Unix.st_ino (hash (Bytes.to_string bytes))))))
  with Unix.Unix_error _ | Sys_error _ -> fail ()

(* Host-only reconciliation: never publish a staged file. A separately
   recorded first-create inode may still be staged before its first link, or
   may already be published. Unverifiable state is left for the operator. *)
let recover_created_profile_locked ~root ~apply =
  let fail () = Error "profile-publication-uncertain" in
  try
        let directory =
          Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0
        in
        Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
            let root_identity = Unix.fstat directory in
            let absent path =
              match Unix.lstat path with
              | exception Unix.Unix_error (Unix.ENOENT, _, _) -> true
              | _ -> false
            in
            if not (absent (marker root) && absent (intent root)
                    && absent (legacy_switch_marker root)) then fail ()
            else
              let record = read_first_intent root in
              let destination = target root in
              match record with
              | None -> fail ()
              | Some (record_identity, bytes) ->
                  let stage =
                    try
                      match
                        Yojson.Safe.Util.member "stage"
                          (Yojson.Safe.from_string bytes)
                      with
                      | `String name when stage_name name ->
                          Some (Filename.concat root name)
                      | _ -> None
                    with Yojson.Json_error _ -> None
                  in
                   match stage with
                   | None -> fail ()
                   | Some stage ->
                       let published =
                         match Unix.lstat destination with
                         | exception Unix.Unix_error (Unix.ENOENT, _, _) ->
                             None
                         | st -> Some st
                       in
                       let staged =
                         match Unix.lstat stage with
                         | exception Unix.Unix_error (Unix.ENOENT, _, _) -> None
                         | st -> Some st
                       in
                       let initial =
                         match (published, staged) with
                         | Some st, _ | None, Some st -> Some st
                         | None, None -> None
                       in
                       match initial with
                       | None -> fail ()
                       | Some initial ->
                         let stage_links =
                           match (published, staged) with
                           | Some _, Some st ->
                               initial.Unix.st_nlink = 2
                               && same initial st && st.Unix.st_nlink = 2
                           | Some _, None -> initial.Unix.st_nlink = 1
                           | None, Some st ->
                               private_file st && same initial st
                           | None, None -> false
                         in
                         if
                           initial.Unix.st_kind <> Unix.S_REG
                           || initial.Unix.st_uid <> Unix.geteuid ()
                           || initial.Unix.st_perm land 0o077 <> 0
                           || initial.Unix.st_size > 1048576
                           || not stage_links
                         then fail ()
                         else
                         let fd =
                           Unix.openfile
                             (if Option.is_some published then destination else stage)
                             [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0
                         in
                        let content =
                          Fun.protect ~finally:(fun () -> Unix.close fd)
                            (fun () ->
                              if not (same initial (Unix.fstat fd)) then None
                              else
                                let buffer = Bytes.create initial.Unix.st_size in
                                let rec read offset =
                                  if offset = Bytes.length buffer then true
                                  else
                                    let n =
                                      Unix.read fd buffer offset
                                        (Bytes.length buffer - offset)
                                    in
                                    n > 0 && read (offset + n)
                                in
                                if read 0 && same initial (Unix.fstat fd)
                                   && (Unix.fstat fd).Unix.st_nlink
                                      = initial.Unix.st_nlink
                                then Some (Bytes.to_string buffer)
                                else None)
                        in
                        match content with
                        | None -> fail ()
                        | Some content ->
                            let* _ =
                              project "invalid-profile-config"
                                (P.of_string content)
                            in
                            let* () =
                              match read_source root with
                              | Error Source_missing -> Ok ()
                              | Ok (source_bytes, _) ->
                                  let* aliases =
                                    project "invalid-profile-config"
                                      (A.parse source_bytes)
                                  in
                                  if aliases = [] then Ok () else fail ()
                              | Error _ -> fail ()
                            in
                            let* expected =
                              try
                                Ok
                                  (first_intent_bytes ~root ~stage
                                     ~identity:initial ~content)
                              with Unix.Unix_error _ -> fail ()
                            in
                            if bytes <> expected then fail ()
                            else
                              let* () =
                                project "unsafe-configuration-root"
                                  (P.validate_private_root root)
                              in
                              if
                                not
                                   (same root_identity (Unix.fstat directory)
                                   && same root_identity (Unix.lstat root)
                                   && (match published with
                                      | Some _ ->
                                          same initial (Unix.lstat destination)
                                          && (Unix.lstat destination).Unix.st_nlink
                                             = initial.Unix.st_nlink
                                      | None -> absent destination)
                                   && (match staged with
                                      | Some _ ->
                                          same initial (Unix.lstat stage)
                                          && (Unix.lstat stage).Unix.st_nlink
                                             = initial.Unix.st_nlink
                                      | None -> absent stage)
                                  && (match read_first_intent root with
                                     | Some (current, value) ->
                                         same record_identity current
                                         && value = bytes
                                     | None -> false)
                                  && absent (marker root) && absent (intent root)
                                  && absent (legacy_switch_marker root))
                               then fail ()
                               else if not apply then
                                 Ok (if Option.is_some published then Published_reconciled else Unpublished_aborted)
                               else
                                 match published with
                                 | None ->
                                     (* Retire and sync the intent while the
                                        exact single-link stage still exists.
                                        An interrupted optional cleanup then
                                        leaves an inert orphan, not an intent
                                        whose evidence we already removed. *)
                                     Unix.unlink (first_intent root);
                                     Unix.fsync directory;
                                     if not (absent destination) then fail ()
                                     else (
                                       (match Unix.lstat stage with
                                       | st
                                         when private_file st
                                              && same initial st ->
                                           cleanup_temp stage initial;
                                           Unix.fsync directory
                                       | exception
                                           Unix.Unix_error (Unix.ENOENT, _, _)
                                         -> ()
                                       | _ -> ());
                                       if absent destination then
                                         Ok Unpublished_aborted
                                       else fail ())
                                 | Some _ ->
                                     (match staged with
                                     | Some _ ->
                                         Unix.unlink stage;
                                         Unix.fsync directory
                                     | None -> ());
                                     if
                                       not
                                         (private_file (Unix.lstat destination)
                                         && same initial (Unix.lstat destination))
                                     then fail ()
                                     else (
                                       Unix.unlink (first_intent root);
                                       Unix.fsync directory;
                                       Ok Published_reconciled))
  with Unix.Unix_error _ | Sys_error _ -> fail ()

let recover_created_profile ~root =
  let* () = project "unsafe-configuration-root" (P.validate_private_root root) in
  let* lock = Result.map_error error_code (acquire_migration_lock root) in
  Fun.protect ~finally:(fun () -> Unix.close lock) (fun () ->
    recover_created_profile_locked ~root ~apply:true)


(* Explicit operator action. Never publish, adopt, or delete an allocated root.
   An unreadable, altered or contradictory record remains in place. *)
let recover_provision_with_checkpoint ?(apply = true) ~checkpoint ~root ~expected () =
  let fail () = Error "profile-publication-uncertain" in
  let allow_linked_target = ref false in
  let read path =
    let before = Unix.lstat path in
    let verified_link = !allow_linked_target && path = target root
      && before.Unix.st_kind = Unix.S_REG && before.Unix.st_uid = Unix.geteuid ()
      && before.Unix.st_perm land 0o077 = 0 && before.Unix.st_nlink = 2 in
    let matches after =
      (unchanged before after || (verified_link && same before after
        && after.Unix.st_kind = Unix.S_REG && after.Unix.st_uid = Unix.geteuid ()
        && after.Unix.st_perm land 0o077 = 0 && after.Unix.st_nlink = 2
        && before.Unix.st_size = after.Unix.st_size && before.Unix.st_mtime = after.Unix.st_mtime
        && before.Unix.st_ctime = after.Unix.st_ctime)) in
    if not (private_file before || verified_link) || before.Unix.st_size > 1048576 then None
    else
      let fd = Unix.openfile path [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
      Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
        if not (matches (Unix.fstat fd)) then None else
        let bytes = Bytes.create before.Unix.st_size in
        let rec loop n =
          if n = Bytes.length bytes then true else
          let count = Unix.read fd bytes n (Bytes.length bytes - n) in
          count > 0 && loop (n + count)
        in
        if loop 0 && matches (Unix.fstat fd) && matches (Unix.lstat path)
        then Some (before, Bytes.to_string bytes) else None)
  in
  try
    let* () = project "unsafe-configuration-root" (P.validate_private_root root) in
    let* lock = Result.map_error error_code (acquire_migration_lock root) in
    Fun.protect ~finally:(fun () -> Unix.close lock) (fun () ->
      let directory = Unix.openfile root [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
        let root_id = Unix.fstat directory in
        let is_absent path = match Unix.lstat path with
          | exception Unix.Unix_error (Unix.ENOENT, _, _) -> true | _ -> false in
        let receipt () =
          match read (provision_receipt root expected) with
          | Some (_, bytes) ->
            (match Yojson.Safe.from_string bytes with
            | `Assoc [("proof", `String proof); ("outcome", `String outcome); ("operation", operation); ("record", `String record)]
                when String.ends_with ~suffix:(":" ^ hash record) proof
                  && Yojson.Safe.Util.member "operation" (Yojson.Safe.from_string record) = operation
                  && proof = expected && String.starts_with
                  ~prefix:(Printf.sprintf "%d:%d:" root_id.Unix.st_dev root_id.Unix.st_ino) proof
                  && same root_id (Unix.lstat root) ->
              (match outcome with "published" -> Ok Published_reconciled
                | "unpublished" -> Ok Unpublished_aborted | _ -> fail ())
            | _ -> fail ())
          | None -> fail () in
        let* first = if is_absent (first_intent root) then Ok None
          else Result.map Option.some (recover_created_profile_locked ~root ~apply:false) in
        allow_linked_target := Option.is_some first;
        if not (same root_id (Unix.lstat root)
                && is_absent (intent root) && is_absent (legacy_switch_marker root)) then fail ()
        else match (try read (provision_intent root) with Unix.Unix_error (Unix.ENOENT, _, _) -> None) with
        | None -> receipt ()
        | Some (identity, bytes) ->
          let proof = Printf.sprintf "%d:%d:%d:%d:%s" root_id.Unix.st_dev root_id.Unix.st_ino
              identity.Unix.st_dev identity.Unix.st_ino (hash bytes) in
          if proof <> expected then receipt () else
          let record = Yojson.Safe.from_string bytes in
          let open Yojson.Safe.Util in
          let fields = match record with `Assoc fields -> fields | _ -> [] in
          let previous = member "previous" record and candidate = member "candidate" record in
          let valid_hash s = String.length s = 64 && String.for_all (function '0'..'9' | 'a'..'f' -> true | _ -> false) s in
          let valid_previous = match previous with `Null -> true | `String s -> valid_hash s | _ -> false in
          if List.sort String.compare (List.map fst fields) <> ["candidate"; "candidate_dev"; "candidate_ino"; "id"; "kind"; "operation"; "previous"; "previous_dev"; "previous_ino"; "root_dev"; "root_ino"; "stage"; "version"]
             || member "version" record <> `Int 1 || member "kind" record <> `String "provision"
             || member "root_dev" record <> `Int root_id.Unix.st_dev || member "root_ino" record <> `Int root_id.Unix.st_ino
             || (match member "operation" record with `Null -> false | `String id ->
               not (String.length id = 32 && String.for_all (function '0'..'9' | 'a'..'f' -> true | _ -> false) id) | _ -> true)
             || not valid_previous || (match candidate with `String s -> not (valid_hash s) | _ -> true)
             || (match member "stage" record with `String s -> not (stage_name s) | _ -> true)
             || (match member "candidate_dev" record, member "candidate_ino" record with `Int _, `Int _ -> false | _ -> true)
             || (match member "id" record with `String s -> not (String.length s = 18 && String.starts_with ~prefix:"p-" s) | _ -> true)
          then fail () else
          let* () = match first with
            | None -> Ok ()
            | Some _ ->
              (match read_first_intent root with
              | Some (_, first_bytes) ->
                let first_record = Yojson.Safe.from_string first_bytes in
                if member "stage" first_record = member "stage" record
                   && member "dev" first_record = member "candidate_dev" record
                   && member "ino" first_record = member "candidate_ino" record
                   && member "digest" first_record = candidate then Ok () else fail ()
              | None -> fail ()) in
          let current = match read (target root) with
            | Some (st, content) -> Some (st, hash content)
            | None -> raise (Unix.Unix_error (Unix.EPERM, "registry", ""))
            | exception Unix.Unix_error (Unix.ENOENT, _, _) -> None in
          let result = if (match previous, current with
            | `Null, None -> member "previous_dev" record = `Null && member "previous_ino" record = `Null
            | `String a, Some (st, b) -> a = b && member "previous_dev" record = `Int st.Unix.st_dev
                && member "previous_ino" record = `Int st.Unix.st_ino
            | _ -> false)
            then Some Unpublished_aborted
            else if (match candidate, current with `String a, Some (st, b) -> a = b
                && member "candidate_dev" record = `Int st.Unix.st_dev
                && member "candidate_ino" record = `Int st.Unix.st_ino | _ -> false)
            then Some Published_reconciled else None in
          match result, read (provision_intent root) with
          | Some result, Some (again, value) when unchanged identity again && value = bytes
              && same root_id (Unix.lstat root)
              && Option.fold ~none:true ~some:(fun outcome -> outcome = result) first ->
              if not apply then Ok result else
              let* () = match first with
                | None -> Ok ()
                | Some _ ->
                  let* actual = recover_created_profile_locked ~root ~apply:true in
                  if actual = result then Ok () else fail () in
              (match first with Some _ -> checkpoint `First_reconciled | None -> ());
              let receipt = Yojson.Safe.to_string (`Assoc [
                ("proof", `String proof);
                ("outcome", `String (match result with Published_reconciled -> "published" | Unpublished_aborted -> "unpublished"));
                ("operation", member "operation" record); ("record", `String bytes)]) ^ "\n" in
              let receipt_path = provision_receipt root proof in
              let* () =
                let exists = not (is_absent receipt_path) in
                if exists then (match read receipt_path with
                  | Some (_, value) when value = receipt -> Ok () | _ -> fail ())
                else if Array.fold_left (fun n name -> if String.starts_with ~prefix:receipt_prefix name then n + 1 else n) 0 (Sys.readdir root) >= 256
                then fail () else Ok () in
              let stage, fd = create_temp root in
              Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
                write_all fd receipt 0; Unix.fchmod fd 0o600; Unix.fsync fd);
              Unix.rename stage receipt_path; Unix.fsync directory;
              checkpoint `Receipt_published;
              if not (same root_id (Unix.lstat root)) then fail () else (
                Unix.unlink (provision_intent root); Unix.fsync directory;
                checkpoint `Intent_removed; Ok result)
          | _ -> fail ()))
  with Unix.Unix_error _ | Sys_error _ | Yojson.Json_error _ -> fail ()

let recover_provision ~root ~expected =
  recover_provision_with_checkpoint ~checkpoint:(fun _ -> ()) ~root ~expected ()

let inspect_provision_outcome ~root =
  let* proof = inspect_provision ~root in
  let* outcome = recover_provision_with_checkpoint ~apply:false ~checkpoint:(fun _ -> ()) ~root ~expected:proof () in
  Ok (proof, outcome)

let inspect_provision_operation ~root ~proof =
  try
    let path = provision_intent root in
    let st = Unix.lstat path in
    if not (private_file st) || st.Unix.st_size > 4096 then raise (Unix.Unix_error (Unix.EPERM, "intent", ""));
    let fd = Unix.openfile path [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
    let bytes = Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
      if not (unchanged st (Unix.fstat fd)) then raise (Unix.Unix_error (Unix.EPERM, "intent", ""));
      let buffer = Bytes.create st.Unix.st_size in
      let rec loop n = if n < Bytes.length buffer then
        let count = Unix.read fd buffer n (Bytes.length buffer - n) in
        if count = 0 then raise (Unix.Unix_error (Unix.EIO, "intent", "")) else loop (n + count) in
      loop 0;
      if not (unchanged st (Unix.fstat fd) && unchanged st (Unix.lstat path)) then raise (Unix.Unix_error (Unix.EPERM, "intent", ""));
      Bytes.to_string buffer) in
    let* current = inspect_provision ~root in
    if current <> proof || not (unchanged st (Unix.lstat path)) then Error "profile-publication-uncertain" else
    match Yojson.Safe.Util.member "operation" (Yojson.Safe.from_string bytes) with
    | `Null -> Ok None
    | `String id when String.length id = 32 && String.for_all (function '0'..'9' | 'a'..'f' -> true | _ -> false) id -> Ok (Some id)
    | _ -> Error "profile-publication-uncertain"
  with Unix.Unix_error _ | Sys_error _ | Yojson.Json_error _ -> Error "profile-publication-uncertain"

let read_private_small path =
  let st = Unix.lstat path in
  if not (private_file st) || st.Unix.st_size > 4096 then None else
  let fd = Unix.openfile path [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
  Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
    let buffer = Bytes.create st.Unix.st_size in
    let rec loop n = if n = Bytes.length buffer then true else
      let count = Unix.read fd buffer n (Bytes.length buffer - n) in count > 0 && loop (n + count) in
    if unchanged st (Unix.fstat fd) && loop 0 && unchanged st (Unix.fstat fd)
       && unchanged st (Unix.lstat path) then Some (st, Bytes.to_string buffer) else None)

let parse_receipt ~root_id ~path bytes =
  let fail () = Error "profile-publication-uncertain" in
  match Yojson.Safe.from_string bytes with
  | `Assoc [("proof", `String proof); ("outcome", `String outcome); ("operation", operation); ("record", `String record)]
    when String.ends_with ~suffix:(":" ^ hash record) proof
      && Yojson.Safe.Util.member "operation" (Yojson.Safe.from_string record) = operation
      && (match operation with `Null -> true | `String id -> String.length id = 32 && String.for_all (function '0'..'9' | 'a'..'f' -> true | _ -> false) id | _ -> false)
      && Filename.basename path = receipt_prefix ^ hash proof
      && String.starts_with ~prefix:(Printf.sprintf "%d:%d:" root_id.Unix.st_dev root_id.Unix.st_ino) proof ->
      (match outcome with "published" -> Ok (proof, Published_reconciled, operation)
        | "unpublished" -> Ok (proof, Unpublished_aborted, operation) | _ -> fail ())
  | _ -> fail ()

let with_receipts ~root f =
  let fail () = Error "profile-publication-uncertain" in
  try
    let* () = project "unsafe-configuration-root" (P.validate_private_root root) in
    let* lock = Result.map_error error_code (acquire_migration_lock root) in
    Fun.protect ~finally:(fun () -> Unix.close lock) (fun () ->
      let directory = Unix.openfile root [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
        let root_id = Unix.fstat directory in
        if not (same root_id (Unix.lstat root)) then fail () else f directory root_id))
  with Unix.Unix_error _ | Sys_error _ | Yojson.Json_error _ -> fail ()

let list_provision_receipts ~root =
  with_receipts ~root (fun _ root_id ->
    let names = Sys.readdir root |> Array.to_list |> List.filter (String.starts_with ~prefix:receipt_prefix) in
    if List.length names > 256 then Error "profile-publication-uncertain" else
    let rec loop acc = function
      | [] -> Ok (List.rev acc)
      | name :: rest ->
        let path = Filename.concat root name in
        let* _, bytes = match read_private_small path with Some v -> Ok v | None -> Error "profile-publication-uncertain" in
        let* receipt = parse_receipt ~root_id ~path bytes in
        loop (receipt :: acc) rest in
    loop [] (List.sort String.compare names))

let forget_provision_receipt ~root ~proof =
  with_receipts ~root (fun directory root_id ->
    let fail () = Error "profile-publication-uncertain" in
    let path = provision_receipt root proof in
    let* () = if String.starts_with ~prefix:(Printf.sprintf "%d:%d:" root_id.Unix.st_dev root_id.Unix.st_ino) proof
      && String.length proof <= 256 then Ok () else fail () in
    match read_private_small path with
    | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok ()
    | None -> fail ()
    | Some (st, bytes) ->
    let* recorded, _, _ = parse_receipt ~root_id ~path bytes in
    if recorded <> proof then fail () else
    let active = match read_private_small (provision_intent root) with
      | Some (intent_id, data) -> Some (Printf.sprintf "%d:%d:%d:%d:%s" root_id.Unix.st_dev root_id.Unix.st_ino
           intent_id.Unix.st_dev intent_id.Unix.st_ino (hash data))
      | None -> raise (Unix.Unix_error (Unix.EPERM, "intent", ""))
      | exception Unix.Unix_error (Unix.ENOENT, _, _) -> None in
    if active = Some proof || not (same root_id (Unix.lstat root)) then fail () else
    match read_private_small path with
    | Some (again, value) when unchanged st again && value = bytes ->
      Unix.unlink path; Unix.fsync directory; Ok ()
    | _ -> fail ())

(* All registry writers cooperate on the migration lock. A first registry is
   linked without replacement; an append replaces only the checked original
   after the complete candidate has been synced. Out-of-band same-UID changes
   are not a filesystem transaction and are outside the native custody model. *)
type profile_publication_point = Before_allocate | Before_publish | After_publish

let write_profile ?(checkpoint = fun _ -> ()) ?(new_id = fun () -> "p-" ^ random_hex ())
    ?managed_admit ?operation_id ~root ~expected_revision ~provision ~profile () =
  let fail code = Error code in
  let* () = match operation_id with
    | None -> Ok ()
    | Some id when provision && String.length id = 32 && String.for_all (function '0'..'9' | 'a'..'f' -> true | _ -> false) id -> Ok ()
    | Some _ -> fail "invalid-request" in
  let* () =
    if not provision then Ok ()
    else
      match profile with
      | `Assoc fields
        when List.length fields = 2
             && List.sort_uniq String.compare (List.map fst fields)
                = [ "backend"; "label" ] -> (
          match (List.assoc "backend" fields, List.assoc "label" fields) with
          | `String ("claude" | "codex" | "opencode-v2"), `String label
            when A.valid_label (String.trim label) -> Ok ()
          | _ -> fail "invalid-request")
      | _ -> fail "invalid-request"
  in
  let* () =
    project "unsafe-configuration-root" (P.validate_private_root root)
  in
  let check_legacy_switch () =
    match Unix.lstat (legacy_switch_marker root) with
    | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok ()
    | _ -> fail "profile-migration-required"
  in
  let check_provision_boundary () =
    if Option.fold ~none:false ~some:(fun admit -> not (admit ())) managed_admit then
      fail "profile-provision-unavailable"
    else if provision then check_legacy_switch ()
    else Ok ()
  in
  (* Hold the lock for the entire operation, not merely the initial check. *)
  let run () =
    let original_root = Unix.lstat root in
    let check_root () =
      if same original_root (Unix.lstat root) then Ok () else fail "unsafe-configuration-root" in
    let* () = check_root () in
    let* () = check_provision_boundary () in
    let* () = if provision then Ok () else check_legacy_switch () in
    let* () =
      match Unix.lstat (first_intent root) with
      | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok ()
      | _ -> fail "profile-publication-uncertain"
    in
    let* () =
      match Unix.lstat (provision_intent root) with
      | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok ()
      | _ -> fail "profile-publication-uncertain"
    in
    let* () =
      match Unix.lstat (intent root) with
      | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok ()
      | _ -> fail "profile-migration-required"
    in
    let marker_present =
      match Unix.lstat (marker root) with
      | exception Unix.Unix_error (Unix.ENOENT, _, _) -> false
      | st when private_file st -> true
      | _ -> raise (Unix.Unix_error (Unix.EPERM, "marker", ""))
    in
    let* () =
      match read_source root with
      | Error Source_missing -> Ok ()
      | Error _ -> fail "invalid-profile-config"
      | Ok (bytes, _) ->
          let* aliases = project "invalid-profile-config" (A.parse bytes) in
          if aliases <> [] && not marker_present then
            fail "profile-migration-required"
          else Ok ()
    in
    let destination = target root in
    let initial =
      match Unix.lstat destination with
      | exception Unix.Unix_error (Unix.ENOENT, _, _) -> None
      | st -> Some st
    in
    let* () =
      if marker_present && Option.is_none initial then
        fail "profile-registry-changed"
      else Ok ()
    in
    let read_current st =
      if not (private_file st) || st.Unix.st_size > 1048576 then
        fail "invalid-profile-config"
      else
        let fd = Unix.openfile destination [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
        Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
            if not (unchanged st (Unix.fstat fd)) then
              fail "profile-registry-changed"
            else
              let bytes = Bytes.create st.Unix.st_size in
              let rec read offset =
                if offset = Bytes.length bytes then Ok ()
                else
                  let n = Unix.read fd bytes offset (Bytes.length bytes - offset) in
                  if n = 0 then fail "profile-registry-changed"
                  else read (offset + n)
              in
              let* () = read 0 in
              if
                not
                  (unchanged st (Unix.fstat fd)
                  && unchanged st (Unix.lstat destination))
              then fail "profile-registry-changed"
              else Ok (Bytes.to_string bytes))
    in
    let* previous =
      match initial with None -> Ok None | Some st -> Result.map Option.some (read_current st)
    in
    let* existing, existing_registry =
      match previous with
      | None -> Ok ([], None)
      | Some bytes ->
          let* registry = project "invalid-profile-config" (P.of_string bytes) in
          (match Yojson.Safe.from_string bytes with
          | `Assoc [ ("version", `Int 1); ("profiles", `List rows) ]
          | `Assoc [ ("profiles", `List rows); ("version", `Int 1) ] ->
              Ok (rows, Some registry)
          | _ -> fail "invalid-profile-config")
    in
    let current_revision = Option.map hash previous in
    let* () =
      if expected_revision = current_revision then Ok ()
      else fail "profile-registry-changed"
    in
    let* fields, new_dirs =
      match (provision, profile) with
      | false, `Assoc fields
        when List.length fields = 4
             && List.sort_uniq String.compare (List.map fst fields)
                = [ "backend"; "id"; "label"; "roots" ] ->
          Ok (fields, [])
      | true, `Assoc fields ->
          let id = new_id () in
          let base = Filename.concat root ("profile-" ^ id) in
          let child name = Filename.concat base name in
          let backend = List.assoc "backend" fields in
          let config = child "config" in
          let roots, dirs =
            match backend with
            | `String "claude" ->
                let history = Filename.concat config "projects" in
                ([ ("config", config); ("history", history) ], [ config; history ])
            | `String "codex" ->
                let state = Filename.concat config "sessions" in
                ([ ("config", config); ("state", state) ], [ config; state ])
            | _ ->
                let roles = [ "config"; "data"; "state"; "cache" ] in
                (List.map (fun role -> (role, child role)) roles, List.map child roles)
          in
          Ok
            ( ("id", `String id)
              :: ("roots", `Assoc (List.map (fun (role, path) -> (role, `String path)) roots))
              :: fields,
              base :: dirs )
      | _ -> fail "invalid-request"
    in
    let managed = Option.is_some managed_admit in
    let enabled = `Assoc (fields @ [ ("enabled", `Bool (managed || not provision)) ]
      @ if managed then [("managed", `Bool true)] else []) in
    let* single =
      project "invalid-request"
        (P.of_string
           (Yojson.Safe.to_string
              (`Assoc [ ("version", `Int 1); ("profiles", `List [ enabled ]) ])))
    in
    let* selected =
      match P.profiles single with
      | [ selected ] -> Ok selected
      | _ -> fail "invalid-request"
    in
    let* () =
      if
        List.exists
          (fun raw ->
            let id = Yojson.Safe.Util.member "id" raw
            and backend = Yojson.Safe.Util.member "backend" raw in
            backend = List.assoc "backend" fields
            && (id = `String (P.id selected)
                || (provision
                    && match Yojson.Safe.Util.member "label" raw with
                       | `String label ->
                           String.lowercase_ascii (String.trim label)
                           = String.lowercase_ascii (P.label selected)
                       | _ -> false)))
          existing
      then fail "profile-already-exists"
      else Ok ()
    in
    let content =
      Yojson.Safe.to_string
        (`Assoc
           [ ("version", `Int 1); ("profiles", `List (existing @ [ enabled ])) ])
      ^ "\n"
    in
    let* candidate = project "invalid-profile-config" (P.of_string content) in
    let* () = check_root () in
    let prepared = if not provision then None else (
      let stage, fd = create_temp root in
      let identity = Unix.fstat fd in
      Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
        write_all fd content 0; Unix.fchmod fd 0o600; Unix.fsync fd);
      Some (stage, identity)) in
    (* The record precedes allocation and survives all uncertain outcomes.
       It is deliberately independent of the first-registry link journal. *)
    let* () = if not provision then Ok () else (
      let record = Yojson.Safe.to_string (`Assoc [
        ("version", `Int 1); ("kind", `String "provision");
        ("root_dev", `Int original_root.Unix.st_dev); ("root_ino", `Int original_root.Unix.st_ino);
        ("operation", Option.fold ~none:`Null ~some:(fun id -> `String id) operation_id);
        ("previous", Option.fold ~none:`Null ~some:(fun value -> `String value) current_revision);
        ("previous_dev", Option.fold ~none:`Null ~some:(fun st -> `Int st.Unix.st_dev) initial);
        ("previous_ino", Option.fold ~none:`Null ~some:(fun st -> `Int st.Unix.st_ino) initial);
        ("stage", `String (Filename.basename (fst (Option.get prepared))));
        ("candidate_dev", `Int (snd (Option.get prepared)).Unix.st_dev);
        ("candidate_ino", `Int (snd (Option.get prepared)).Unix.st_ino);
        ("candidate", `String (hash content));
        ("id", List.assoc "id" fields)
      ]) ^ "\n" in
      let fd = Unix.openfile (provision_intent root)
        [Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC] 0o600 in
      Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
        write_all fd record 0; Unix.fsync fd);
      let directory = Unix.openfile root [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
      Fun.protect ~finally:(fun () -> Unix.close directory) (fun () -> Unix.fsync directory);
      Ok ()) in
    if provision then checkpoint Before_allocate;
    let* () = check_root () in
    let* () =
      match new_dirs with
      | [] -> Ok ()
      | base :: children ->
          (* Never adopt a colliding entry, even if it is an empty directory.
             If interrupted after mkdir, retain the unpublished subtree. Neither
             normal reads nor registry recovery adopt or delete its directories. *)
          let* () =
            match existing_registry with
            | None -> Ok ()
            | Some registry -> project "unsafe-profile-roots" (check_roots registry)
          in
          let* () = project "unsafe-configuration-root" (P.validate_private_root root) in
          (match Unix.mkdir base 0o700 with
           | exception Unix.Unix_error (Unix.EEXIST, _, _) ->
               (* mkdir performed no allocation. Retire only our newly written
                  record, synchronously, before reporting the definite refusal. *)
               if provision then (
                 Unix.unlink (provision_intent root);
                 Option.iter (fun (stage, identity) -> cleanup_temp stage identity) prepared;
                 let fd = Unix.openfile root [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
                 Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> Unix.fsync fd));
               fail "profile-already-exists"
           | () ->
               List.iter (fun dir -> Unix.mkdir dir 0o700) children;
               List.iter
                 (fun dir ->
                   let fd = Unix.openfile dir [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
                   Fun.protect ~finally:(fun () -> Unix.close fd) (fun () -> Unix.fsync fd))
                 (List.rev new_dirs);
               Ok ())
    in
    let after_allocation result =
      if provision then project "profile-publication-uncertain" result else result
    in
    let* () = after_allocation
      (
      project "unsafe-profile-roots"
        (P.validate_roots ~registry:candidate selected))
    in
    let* () = after_allocation (project "unsafe-profile-roots" (check_roots candidate)) in
    let directory =
      Unix.openfile root [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0
    in
    Fun.protect ~finally:(fun () -> Unix.close directory) (fun () ->
        let root_identity = Unix.fstat directory in
        let check () =
          let* () = check_root () in
          let* () = check_provision_boundary () in
          let* () =
            project "unsafe-configuration-root"
              (P.validate_private_root root)
          in
          let* () =
            if
              same root_identity (Unix.lstat root)
              && same root_identity (Unix.fstat directory)
            then Ok ()
            else fail "unsafe-configuration-root"
          in
          let* () =
            match (initial, previous) with
            | None, None ->
                (match Unix.lstat destination with
                | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok ()
                | _ -> fail "profile-registry-changed")
            | Some initial, Some bytes ->
                let* current = read_current initial in
                if current = bytes then Ok ()
                else fail "profile-registry-changed"
            | _ -> fail "profile-registry-changed"
          in
          let* () =
            match Unix.lstat (intent root) with
            | exception Unix.Unix_error (Unix.ENOENT, _, _) -> Ok ()
            | _ -> fail "profile-migration-required"
          in
          let* () =
            match Unix.lstat (marker root) with
            | exception Unix.Unix_error (Unix.ENOENT, _, _)
              when not marker_present -> Ok ()
            | st when marker_present && private_file st -> Ok ()
            | _ -> fail "profile-registry-changed"
          in
          let* () =
            match read_source root with
            | Error Source_missing when not marker_present -> Ok ()
            | Error Source_missing when marker_present -> Ok ()
            | Ok (bytes, _) when marker_present -> project "invalid-profile-config" (A.parse bytes) |> Result.map (fun _ -> ())
            | Ok (bytes, _) ->
                let* aliases = project "invalid-profile-config" (A.parse bytes) in
                if aliases = [] then Ok () else fail "profile-migration-required"
            | Error _ -> fail "invalid-profile-config"
          in
          let* () =
            project "unsafe-profile-roots"
              (P.validate_roots ~registry:candidate selected)
          in
          project "unsafe-profile-roots" (check_roots candidate)
        in
        let stage, fd, stage_identity = match prepared with
          | Some (stage, identity) ->
              let fd = Unix.openfile stage [Unix.O_RDWR; Unix.O_CLOEXEC] 0 in
              (stage, fd, identity)
          | None -> let stage, fd = create_temp root in (stage, fd, Unix.fstat fd) in
         Fun.protect
           ~finally:(fun () ->
             cleanup_first_stage ~root ~stage ~identity:stage_identity)
          (fun () ->
            Fun.protect ~finally:(fun () -> Unix.close fd) (fun () ->
                if not (private_file (Unix.fstat fd) && same stage_identity (Unix.fstat fd)) then
                  raise (Unix.Unix_error (Unix.EPERM, "stage", ""));
                write_all fd content 0;
                Unix.fchmod fd 0o600;
                Unix.fsync fd);
            let* () = after_allocation (check ()) in
            if not (private_file (Unix.lstat stage)
                    && same stage_identity (Unix.lstat stage)) then
              after_allocation (fail "profile-registry-changed")
            else (
              let* () = (match initial with
              | None ->
                  write_first_intent ~root ~directory ~stage ~content;
                  let* () =
                    match check () with
                    | Ok () -> Ok ()
                    | Error _ -> fail "profile-publication-uncertain"
                  in
                  checkpoint Before_publish;
                  Unix.link stage destination;
                  checkpoint After_publish;
                  Unix.unlink stage;
                  Unix.fsync directory;
                  Unix.unlink (first_intent root);
                  Ok ()
              | Some _ ->
                  checkpoint Before_publish;
                  Unix.rename stage destination;
                  checkpoint After_publish;
                  Ok ()) in
              Unix.fsync directory;
              Ok (P.registry_revision candidate, P.public_json selected))))
  in
  try
    let* fd = Result.map_error error_code (acquire_migration_lock root) in
    Fun.protect ~finally:(fun () -> Unix.close fd) run
  with Unix.Unix_error _ | Sys_error _ -> fail "profile-publication-uncertain"

let create_profile ~root ~expected_revision ~profile =
  write_profile ~provision:false ~root ~expected_revision ~profile ()

let provision_profile ~root ~expected_revision ~profile =
  write_profile ~provision:true ~root ~expected_revision ~profile ()

let provision_profile_with_operation ~operation_id ~root ~expected_revision ~profile =
  write_profile ~operation_id ~provision:true ~root ~expected_revision ~profile ()

let provision_managed ~admit ~root ~expected_revision ~profile =
  write_profile ~managed_admit:admit ~provision:true ~root ~expected_revision ~profile ()

let provision_managed_with_operation ~operation_id ~admit ~root ~expected_revision ~profile =
  write_profile ~operation_id ~managed_admit:admit ~provision:true ~root ~expected_revision ~profile ()
