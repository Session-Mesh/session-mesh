(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type kind = Claude | Codex
type error = Carry_base.error = { code : string; message : string }

type limits = Carry_base.limits = {
  max_files : int;
  max_bytes : int;
  free_margin : int;
}

type outcome = {
  files : int;
  copied : int;
  replaced : int;
  unchanged : int;
  bytes : int;
  recovery_copies : int;
}

type io = Carry_write.io = {
  write : Unix.file_descr -> bytes -> int -> int -> int;
  read : Unix.file_descr -> bytes -> int -> int -> int;
  unlink : string -> unit;
  rename : string -> string -> unit;
  rename_noreplace : string -> string -> unit;
  link : string -> string -> unit;
  close : Unix.file_descr -> unit;
  free_bytes : string -> int option;
}

let default_io =
  {
    write = Unix.write;
    read = Unix.read;
    unlink = Unix.unlink;
    rename = Unix.rename;
    rename_noreplace = Carry_write.rename_noreplace;
    link = Unix.link;
    close = Unix.close;
    free_bytes = Carry_target.free_bytes;
  }

(* Shared publication primitive: fail closed if atomic no-replace is unavailable. *)
let rename_noreplace = Carry_write.rename_noreplace

let default_limits = Carry_base.default_limits

let kind_of_string = function
  | "claude" -> Some Claude
  | "codex" -> Some Codex
  | _ -> None

let is_login_file = Carry_base.is_login_file
let lock_name = Carry_target.lock_name

open Carry_base

let valid_conversation_id id =
  let length = String.length id in
  length >= 8 && length <= 64
  && (match id.[0] with
    | '0' .. '9' | 'A' .. 'Z' | 'a' .. 'z' -> true
    | _ -> false)
  && String.for_all
       (function
         | '0' .. '9' | 'A' .. 'Z' | 'a' .. 'z' | '_' | '-' -> true | _ -> false)
       id

(* Codex names its rollouts after a UUID: only a whole one is looked for. *)
let valid_id kind id =
  valid_conversation_id id && (kind = Claude || valid_uuid id)

(* ------------------------------------------------------------ the folders *)

let agent_names = function
  | Claude -> ("CLAUDE_CONFIG_DIR", ".claude", "Claude")
  | Codex -> ("CODEX_HOME", ".codex", "Codex")

let default_folder ~getenv kind =
  let variable, default_name, _ = agent_names kind in
  match (getenv variable, getenv "HOME") with
  | Some configured, _ when not (Filename.is_relative configured) ->
      Ok configured
  | _, Some home when not (Filename.is_relative home) ->
      Ok (join home default_name)
  | _ -> fail "account_folder_refused" "no home folder for the default account"

module R = Mesh_account_resolver

let resolver_result result =
  Result.map_error
    (fun (error : R.error) -> { code = error.code; message = error.message })
    result

(* The alias is never echoed: only an id that matched a valid one is. *)
let alias_folder ~uid ~getenv ~file ~create kind account =
  let backend = match kind with Claude -> R.Claude | Codex -> R.Codex in
  let* accounts = resolver_result (R.load ~uid ~file) in
  let* entry = resolver_result (R.find accounts { backend; id = account }) in
  resolver_result (R.carry_folder ~uid ~getenv ~create entry)

let account_folder ~uid ~getenv ~file ~kind ~create account =
  sanitized
    (if account <> "default" then
       alias_folder ~uid ~getenv ~file ~create kind account
     else
       let* folder = default_folder ~getenv kind in
       let checked =
         if create then Mesh_accounts.prepare_directory ~uid folder
         else Mesh_accounts.check_directory ~uid folder
       in
       match checked with
       | Ok () -> Ok folder
       | Error message -> fail "account_folder_refused" message)

let existing_folder ~uid folder =
  let* () =
    Result.map_error
      (fun message -> { code = "account_folder_refused"; message })
      (Mesh_accounts.check_directory ~uid folder)
  in
  match Unix.lstat folder with
  | { Unix.st_kind = Unix.S_DIR; _ } -> Ok ()
  | _ | (exception Unix.Unix_error _) ->
      fail "account_folder_refused" "the account folder does not exist"

let folder_changed () =
  fail "account_folder_refused" "an account folder changed during the carry"

(* Keep the directory open as well as its identity: a removed inode cannot be
   reused for a replacement while this operation still refers to it. *)
let with_bound_folder ~uid folder f =
  let* () = existing_folder ~uid folder in
  let* before = lstat_opt folder in
  match before with
  | None -> folder_changed ()
  | Some before -> (
      match Carry_target.open_directory folder with
      | exception Unix.Unix_error _ -> folder_changed ()
      | descriptor ->
          Fun.protect
            ~finally:(fun () -> Unix.close descriptor)
            (fun () ->
              match Unix.fstat descriptor with
              | identity
                when identity.Unix.st_kind = Unix.S_DIR
                     && Carry_target.same_file before identity
                     && Carry_target.same_directory ~target:folder identity ->
                  f identity
              | _ | (exception Unix.Unix_error _) -> folder_changed ()))

let check_bound_folder ~uid folder identity =
  if Carry_target.same_directory ~target:folder identity then
    existing_folder ~uid folder
  else folder_changed ()

(* This is the only source read for one carry. Even a mixed default/named pair
   needs one validated snapshot before either folder is looked up. All-default
   carries retain their historical independence from account configuration.
   Later registry edits apply to the next operation; this one keeps its selected
   entries and rechecks directory custody/identity, never re-resolving names. *)
let pair_entries ~uid ~file ~kind ~from_account ~to_account =
  let backend = match kind with Claude -> R.Claude | Codex -> R.Codex in
  let* accounts =
    resolver_result
      (if from_account = R.default_id && to_account = R.default_id then
         R.of_accounts []
       else R.load ~uid ~file)
  in
  let* source =
    resolver_result (R.find accounts { backend; id = from_account })
  in
  let* target = resolver_result (R.find accounts { backend; id = to_account }) in
  Ok (source, target)

let pinned_folder ~uid entry folder =
  (* A synthetic default must not query the caller's environment again. *)
  let getenv _ = Some folder in
  let* checked = resolver_result (R.carry_folder ~uid ~getenv ~create:false entry) in
  if checked = folder then Ok () else folder_changed ()

(* An exclusive mkdir establishes creation but does not return the directory's
   identity. A subsequent lstat validates the path, not cleanup custody. *)
let prepare_pinned_target ~uid entry folder =
  let* () = pinned_folder ~uid entry folder in
  let* before = lstat_opt folder in
  match before with
  | Some identity -> Ok (false, identity)
  | None -> (
      match Unix.mkdir folder 0o700 with
      | () ->
          (match lstat_opt folder with
          | Ok (Some identity) when identity.Unix.st_kind = Unix.S_DIR ->
              Ok (true, identity)
          | _ ->
              fail "carry_rollback_incomplete"
                "account folder cleanup unconfirmed after creation")
      | exception Unix.Unix_error (Unix.EEXIST, _, _) -> folder_changed ()
      | exception Unix.Unix_error _ ->
          fail "account_folder_refused" "the account folder could not be created")

(* ------------------------------------------------------------- the carry *)

let all f items =
  List.fold_left
    (fun acc item ->
      let* () = acc in
      f item)
    (Ok ()) items

let map_all f items =
  let* reversed =
    List.fold_left
      (fun acc item ->
        let* acc = acc in
        let* mapped = f item in
        Ok (mapped :: acc))
      (Ok []) items
  in
  Ok (List.rev reversed)

let check_bounds limits files =
  let count = List.length files in
  let bytes = List.fold_left (fun total (_, size) -> total + size) 0 files in
  if count > limits.max_files || bytes > limits.max_bytes then
    fail "conversation_too_large"
      (Printf.sprintf
         "the conversation holds %d files and %d bytes; a carry takes at most \
          %d files and %d bytes"
         count bytes limits.max_files limits.max_bytes)
  else Ok ()

let bytes_written planned =
  List.fold_left
    (fun total (_, size, action) ->
      if action = Carry_write.Same then total else total + size)
    0 planned

(* After the copy, the target's file system keeps [free_margin] bytes free.
   The replaced copies stay until the end, so every byte written counts. *)
let check_space io limits ~target planned =
  let needed = bytes_written planned in
  if needed = 0 then Ok ()
  else
    match io.free_bytes target with
    | None -> fail "carry_failed" "the free space of the target is unknown"
    | Some free when free < needed + limits.free_margin ->
        fail "target_no_space"
          (Printf.sprintf
             "the carry writes %d bytes and keeps %d bytes free; the target's \
              file system has %d"
             needed limits.free_margin free)
    | Some _ -> Ok ()

let outcome_of ~target planned =
  let count wanted =
    List.length (List.filter (fun (_, _, action) -> action = wanted) planned)
  in
  {
    files = List.length planned;
    copied = count Carry_write.Copy;
    replaced = List.length (List.filter (fun (_, _, action) -> match action with Carry_write.Replace _ -> true | _ -> false) planned);
    unchanged = count Carry_write.Same;
    bytes = bytes_written planned;
    recovery_copies =
      List.fold_left (fun total (relative, _, _) ->
        let final = Filename.concat target relative in
        let prefix = "." ^ Filename.basename final ^ ".carry-saved-" in
        let entries = Sys.readdir (Filename.dirname final) in
        total + Array.length (Array.of_list (Array.to_list entries |> List.filter
          (fun name -> String.starts_with ~prefix name && String.length name = String.length prefix + 16))))
        0 planned;
  }

(* Under the lock: locate, bound, clean a killed carry's files, plan, check
   the free space, write. *)
let carry_locked ?(check_roots = fun () -> Ok ()) io limits ~uid ~kind
    ~conversation ~source ~target =
  let* () = check_roots () in
  let* files =
    match kind with
    | Claude -> Carry_locate.claude_files ~uid ~source conversation
    | Codex -> Carry_locate.codex_files ~uid ~source conversation
  in
  let* () = check_bounds limits files in
  let relatives = List.map fst files in
  let* () = all (Carry_target.check_folders ~uid ~target) relatives in
  let* () = check_roots () in
  let* _ = Carry_target.clean_leftovers ~uid ~target relatives in
  let* planned = map_all (Carry_write.plan io ~uid ~source ~target) files in
  let* () = check_roots () in
  let space = check_space io limits ~target planned in
  let* () = check_roots () in
  let* () = space in
  let* () = Carry_write.write_plan ~check_roots io ~uid ~source ~target planned in
  let* () = check_roots () in
  match outcome_of ~target planned with
  | outcome -> Ok outcome
  | exception Sys_error _ ->
      fail "carry_rollback_incomplete"
        "the carry was installed but recovery copies could not be listed; review the target account"

let check_id kind conversation =
  if valid_id kind conversation then Ok ()
  else fail "conversation_unknown" "not a conversation id"

let check_pair ~uid ~source ~target =
  let* () = existing_folder ~uid source in
  let* () = existing_folder ~uid target in
  let same =
    match (Unix.stat source, Unix.stat target) with
    | a, b -> a.st_dev = b.st_dev && a.st_ino = b.st_ino
    | exception Unix.Unix_error _ -> source = target
  in
  if same then fail "account_same" "both accounts use the same folder"
  else Ok ()

let carry ?(io = default_io) ?(limits = default_limits) ~uid ~kind ~conversation
    ~source ~target () =
  sanitized
    (let* () = check_id kind conversation in
     let* () = check_pair ~uid ~source ~target in
     Carry_target.with_lock ~uid ~target conversation (fun _ ->
         carry_locked io limits ~uid ~kind ~conversation ~source ~target))

(* Hooks may mutate directories too. Check on both sides of every supplied IO
   operation, and let write_plan retain recovery files instead of rolling back
   through a replaced root. Closing must still release its descriptor. *)
let bound_io check_roots (io : io) =
  let ensure () =
    match check_roots () with
    | Ok () -> ()
    | Error _ -> raise (Unix.Unix_error (Unix.EIO, "carry", ""))
  in
  let around f =
    ensure ();
    let result = f () in
    ensure ();
    result
  in
  {
    io with
    read =
      (fun fd bytes offset length ->
        around (fun () -> io.read fd bytes offset length));
    write =
      (fun fd bytes offset length ->
        around (fun () -> io.write fd bytes offset length));
    unlink = (fun path -> around (fun () -> io.unlink path));
    rename = (fun before after -> around (fun () -> io.rename before after));
    rename_noreplace = (fun before after -> around (fun () -> io.rename_noreplace before after));
    link = (fun before after -> around (fun () -> io.link before after));
    close =
      (fun fd ->
        io.close fd;
        ensure ());
  }

let carry_accounts ?(io = default_io) ?(limits = default_limits) ?expected_contexts ?(legacy_only = false) ~uid ~getenv
    ~file ~kind ~conversation ~from_account ~to_account () =
  sanitized
    (let* () = check_id kind conversation in
     let* (source_entry, target_entry) =
       pair_entries ~uid ~file ~kind ~from_account ~to_account
     in
     let* () =
       if legacy_only && Option.is_some expected_contexts then
         fail "profile-context-changed" "conflicting account source bindings"
       else if legacy_only
               && ((from_account <> R.default_id && Option.is_some (R.context_revision source_entry))
                   || (to_account <> R.default_id && Option.is_some (R.context_revision target_entry))) then
         fail "profile-context-changed" "account source changed to the native registry"
       else Ok ()
     in
     let* () =
       match expected_contexts with
       | None -> Ok ()
       | Some (source_revision, target_revision) ->
           if (from_account = R.default_id || R.context_revision source_entry = Some source_revision)
              && (to_account = R.default_id || R.context_revision target_entry = Some target_revision)
           then Ok ()
           else fail "profile-context-changed" "selected profile context changed"
     in
     let getenv =
       if from_account = R.default_id || to_account = R.default_id then
         let variable, _, _ = agent_names kind in
         let home = getenv "HOME" in
         let configured = getenv variable in
         (function
         | "HOME" -> home
         | name when name = variable -> configured
         | _ -> None)
       else getenv
     in
     let* source =
       resolver_result (R.carry_folder ~uid ~getenv ~create:false source_entry)
     in
     let* target =
       resolver_result (R.carry_folder ~uid ~getenv ~create:false target_entry)
     in
     let* () =
       match expected_contexts with
       | None -> Ok ()
       | Some (source_revision, target_revision) ->
           let default_revision folder =
             let backend = match kind with Claude -> "claude" | Codex -> "codex" in
             Digestif.SHA256.(to_hex (digest_string ("mesh-default-v1\000" ^ backend ^ "\000" ^ folder)))
           in
           if (from_account <> R.default_id || default_revision source = source_revision)
              && (to_account <> R.default_id || default_revision target = target_revision)
           then Ok ()
           else fail "profile-context-changed" "selected profile context changed"
     in
      with_bound_folder ~uid source (fun source_identity ->
          let* () = pinned_folder ~uid source_entry source in
          (* Refuse an absent or invalid conversation before creating a target.
             Repeat the discovery under the target lock before any copy. *)
          let* files = match kind with
            | Claude -> Carry_locate.claude_files ~uid ~source conversation
            | Codex -> Carry_locate.codex_files ~uid ~source conversation
          in
          let* () = check_bounds limits files in
          let* () = check_bound_folder ~uid source source_identity in
          let* unproven_creation, before =
            prepare_pinned_target ~uid target_entry target
          in
          let result =
            Carry_target.with_target_binding ~target ~created:false
              ~identity:before (with_bound_folder ~uid target)
              (fun target_identity ->
                let check_roots () =
                  let* () = check_bound_folder ~uid source source_identity in
                  check_bound_folder ~uid target target_identity
                in
                let* () =
                  if Carry_target.same_file before target_identity then Ok ()
                  else folder_changed ()
                in
                let* () = pinned_folder ~uid target_entry target in
                let* () = check_roots () in
                let* () =
                  if Carry_target.same_file source_identity target_identity then
                    fail "account_same" "both accounts use the same folder"
                  else Ok ()
                in
                let io = bound_io check_roots io in
                Carry_target.with_lock ~uid ~target conversation (fun _ ->
                    carry_locked ~check_roots io limits ~uid ~kind ~conversation
                      ~source ~target))
          in
          match result with
          | Error error when unproven_creation && error.code = "target_no_space" ->
              Error { error with message = error.message ^ "; account folder cleanup unconfirmed" }
          | Error error when unproven_creation
                             && (error.code = "carry_rollback_incomplete"
                                || error.code = "carry_restore_failed") ->
              Error
                { error with
                  message =
                    error.message ^ "; account folder cleanup unconfirmed" }
          | Error error when unproven_creation ->
              fail "carry_rollback_incomplete"
                ("the carry failed; account folder cleanup unconfirmed ("
               ^ error.message ^ ")")
          | _ -> result))

let outcome_to_json outcome =
  `Assoc
    [
      ("files", `Int outcome.files);
      ("copied", `Int outcome.copied);
      ("replaced", `Int outcome.replaced);
      ("unchanged", `Int outcome.unchanged);
      ("bytes", `Int outcome.bytes);
      ("recovery_copies", `Int outcome.recovery_copies);
    ]

let carry_pi_accounts ~uid ~file ~conversation ~from_account ~to_account
    ~source_revision ~target_revision =
  let* registry = resolver_result (R.load ~uid ~file) in
  let find id = resolver_result (R.find registry { backend = R.Pi; id }) in
  let* source = find from_account in
  let* target = find to_account in
  let* () =
    if R.context_revision source = Some source_revision
       && R.context_revision target = Some target_revision
    then Ok ()
    else fail "profile-context-changed" "selected Pi account context changed"
  in
  let history entry revision =
    let* context =
      resolver_result (R.launch_context ~uid ~expected_context:revision entry)
    in
    match List.assoc_opt "history" context.roots with
    | Some root -> Ok root
    | None -> fail "account_folder_refused" "Pi history root is unavailable"
  in
  let* source = history source source_revision in
  let* target = history target target_revision in
  let* carried = Carry_pi.carry ~uid ~source ~target ~conversation () in
  Ok
    {
      files = carried.files;
      copied = carried.copied;
      replaced = carried.replaced;
      unchanged = carried.unchanged;
      bytes = carried.bytes;
      recovery_copies = 0;
    }

let opencode_profile_lock = "opencode-profile"

let exec_opencode_profile ~uid ~file ~profile ~revision ~executable ~args =
  let* registry = resolver_result (R.load ~uid ~file) in
  let* entry = resolver_result (R.find registry { backend = R.Opencode_v2; id = profile }) in
  let* context =
    resolver_result (R.launch_context ~uid ~expected_context:revision entry)
  in
  match List.assoc_opt "data" context.roots with
  | Some data when not (Filename.is_relative executable)
                  && Sys.getenv_opt "XDG_DATA_HOME" = Some data ->
      Carry_target.with_lock ~shared:true ~uid ~target:data opencode_profile_lock (fun fd ->
          try
            Unix.clear_close_on_exec fd;
            Unix.execv executable (Array.of_list (executable :: args))
          with Unix.Unix_error _ ->
            fail "helper-unavailable" "OpenCode executable unavailable")
  | _ -> fail "profile-context-changed" "selected OpenCode data folder changed"

let carry_opencode_accounts ~uid ~file ~binary ~home ~workspace ~source_runtime
    ~target_runtime ~conversation ~from_account ~to_account ~source_revision
    ~target_revision ~logical_id ~epoch ~receipt_directory ~operation_id =
  let module Transfer = Mesh_opencode_transfer in
  let* registry = resolver_result (R.load ~uid ~file) in
  let find id = resolver_result (R.find registry { backend = R.Opencode_v2; id }) in
  let* source = find from_account in
  let* target = find to_account in
  let* () =
    if uid = Unix.geteuid () && from_account <> to_account
       && R.context_revision source = Some source_revision
       && R.context_revision target = Some target_revision
    then Ok ()
    else fail "profile-context-changed" "selected OpenCode account context changed"
  in
  let context entry revision runtime =
    let* launch =
      resolver_result (R.launch_context ~uid ~expected_context:revision entry)
    in
    let root role = List.assoc_opt role launch.roots in
    match (root "config", root "data", root "state", root "cache") with
    | Some config, Some data, Some state, Some cache ->
        Ok { Transfer.home; config; data; state; cache; runtime; location = workspace }
    | _ -> fail "account_folder_refused" "OpenCode account roots are unavailable"
  in
  let* source = context source source_revision source_runtime in
  let* target = context target target_revision target_runtime in
  let disjoint = try Transfer.disjoint source target with Unix.Unix_error _ -> false in
  if not disjoint then
    fail "account_folder_refused" "OpenCode account roots overlap"
  else
    let first, second =
      if String.compare source.data target.data < 0 then (source.data, target.data)
      else (target.data, source.data)
    in
    Carry_target.with_lock ~uid ~target:first opencode_profile_lock (fun _ ->
        Carry_target.with_lock ~uid ~target:second opencode_profile_lock (fun _ ->
            Transfer.run_fork ~binary ~source ~target ~parent_native_id:conversation
              ~logical_id ~epoch ~source_profile:from_account ~target_profile:to_account
              ~receipt_directory ~operation_id
            |> Result.map_error (fun code -> { code; message = "OpenCode conversation transfer refused" })))
