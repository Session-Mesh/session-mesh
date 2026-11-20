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
}

type io = Carry_write.io = {
  write : Unix.file_descr -> bytes -> int -> int -> int;
  rename : string -> string -> unit;
  close : Unix.file_descr -> unit;
  free_bytes : string -> int option;
}

let default_io =
  {
    write = Unix.write;
    rename = Unix.rename;
    close = Unix.close;
    free_bytes = Carry_target.free_bytes;
  }

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

(* The alias is never echoed: only an id that matched a valid one is. *)
let alias_folder ~uid ~file kind account =
  let _, _, field = agent_names kind in
  let* accounts =
    Result.map_error
      (fun message -> { code = "accounts_refused"; message })
      (Mesh_accounts.load ~uid file)
  in
  let* found =
    Option.to_result
      ~none:{ code = "account_unknown"; message = "unknown account" }
      (List.find_opt
         (fun (alias : Mesh_accounts.account) -> alias.id = account)
         accounts)
  in
  Option.to_result
    ~none:
      {
        code = "account_no_agent";
        message = Printf.sprintf "account %s has no %s folder" found.id field;
      }
    (match kind with
    | Claude -> found.claude_config_dir
    | Codex -> found.codex_home)

let resolve_folder ~uid ~getenv ~file ~kind account =
  if account = "default" then default_folder ~getenv kind
  else alias_folder ~uid ~file kind account

let account_folder ~uid ~getenv ~file ~kind ~create account =
  sanitized
    (let* folder = resolve_folder ~uid ~getenv ~file ~kind account in
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

let outcome_of planned =
  let count wanted =
    List.length (List.filter (fun (_, _, action) -> action = wanted) planned)
  in
  {
    files = List.length planned;
    copied = count Carry_write.Copy;
    replaced = count Carry_write.Replace;
    unchanged = count Carry_write.Same;
    bytes = bytes_written planned;
  }

(* Under the lock: locate, bound, clean a killed carry's files, plan, check
   the free space, write. *)
let carry_locked io limits ~uid ~kind ~conversation ~source ~target =
  let* files =
    match kind with
    | Claude -> Carry_locate.claude_files ~uid ~source conversation
    | Codex -> Carry_locate.codex_files ~uid ~source conversation
  in
  let* () = check_bounds limits files in
  let relatives = List.map fst files in
  let* () = all (Carry_target.check_folders ~uid ~target) relatives in
  let* () = Carry_target.clean_leftovers ~uid ~target relatives in
  let* planned = map_all (Carry_write.plan ~uid ~source ~target) files in
  let* () = check_space io limits ~target planned in
  let* () = Carry_write.write_plan io ~uid ~source ~target planned in
  Ok (outcome_of planned)

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
     Carry_target.with_lock ~uid ~target conversation (fun () ->
         carry_locked io limits ~uid ~kind ~conversation ~source ~target))

(* A target folder this run created is removed again when the carry fails:
   it then holds only the lock file. *)
let carry_accounts ?(io = default_io) ?(limits = default_limits) ~uid ~getenv
    ~file ~kind ~conversation ~from_account ~to_account () =
  sanitized
    (let* () = check_id kind conversation in
     let folder = account_folder ~uid ~getenv ~file ~kind in
     let* source = folder ~create:false from_account in
     let* path = resolve_folder ~uid ~getenv ~file ~kind to_account in
     let existed =
       match Unix.lstat path with
       | _ -> true
       | exception Unix.Unix_error _ -> false
     in
     let* target = folder ~create:true to_account in
     let* () = check_pair ~uid ~source ~target in
     Carry_target.with_lock ~uid ~target conversation (fun () ->
         match
           carry_locked io limits ~uid ~kind ~conversation ~source ~target
         with
         | Error _ as refused when not existed ->
             quietly (fun () -> Unix.unlink (join target lock_name));
             quietly (fun () -> Unix.rmdir target);
             refused
         | result -> result))

let outcome_to_json outcome =
  `Assoc
    [
      ("files", `Int outcome.files);
      ("copied", `Int outcome.copied);
      ("replaced", `Int outcome.replaced);
      ("unchanged", `Int outcome.unchanged);
      ("bytes", `Int outcome.bytes);
    ]
