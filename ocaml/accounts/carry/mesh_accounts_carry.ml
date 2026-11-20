(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

type kind = Claude | Codex
type error = Carry_base.error = { code : string; message : string }

type outcome = {
  files : int;
  copied : int;
  replaced : int;
  unchanged : int;
  bytes : int;
}

type io = {
  write : Unix.file_descr -> bytes -> int -> int -> int;
  rename : string -> string -> unit;
}

let default_io = { write = Unix.write; rename = Unix.rename }

let kind_of_string = function
  | "claude" -> Some Claude
  | "codex" -> Some Codex
  | _ -> None

let login_files = Carry_base.login_files

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

(* ------------------------------------------------------------ the folders *)

let account_folder ~uid ~getenv ~file ~kind ~create account =
  let variable, default_name, field =
    match kind with
    | Claude -> ("CLAUDE_CONFIG_DIR", ".claude", "Claude")
    | Codex -> ("CODEX_HOME", ".codex", "Codex")
  in
  let* folder =
    if account = "default" then
      match (getenv variable, getenv "HOME") with
      | Some configured, _ when not (Filename.is_relative configured) ->
          Ok configured
      | _, Some home when not (Filename.is_relative home) ->
          Ok (join home default_name)
      | _ -> fail "account_folder_refused" "no home folder for the default account"
    else
      match Mesh_accounts.load ~uid file with
      | Error message -> fail "accounts_refused" message
      | Ok accounts -> (
          match
            List.find_opt (fun (a : Mesh_accounts.account) -> a.id = account) accounts
          with
          | None -> fail "account_unknown" ("unknown account " ^ account)
          | Some found -> (
              match
                match kind with
                | Claude -> found.claude_config_dir
                | Codex -> found.codex_home
              with
              | Some folder -> Ok folder
              | None ->
                  fail "account_no_agent"
                    (Printf.sprintf "account %s has no %s folder" account field)))
  in
  let checked =
    if create then Mesh_accounts.prepare_directory ~uid folder
    else Mesh_accounts.check_directory ~uid folder
  in
  match checked with
  | Ok () -> Ok folder
  | Error message -> fail "account_folder_refused" message

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

(* ---------------------------------------------------------- the target *)

type action = Copy | Replace | Same

(* A regular file read without following a link (Mesh_safe_file). *)
let with_reading path f =
  match Mesh_safe_file.with_regular path (fun descriptor stats -> f descriptor stats) with
  | Ok result -> result
  | Error error -> fail "carry_failed" (Mesh_safe_file.error_message error)

(* A new file: O_EXCL with O_CREAT never follows a link, nor opens a file
   someone put there first. *)
let with_new_file path f =
  match
    Unix.openfile path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ] 0o600
  with
  | exception Unix.Unix_error (error, _, _) ->
      fail "carry_failed" (Unix.error_message error)
  | descriptor -> Fun.protect ~finally:(fun () -> Unix.close descriptor) (fun () -> f descriptor)

let rec really_read descriptor buffer offset length =
  if length = 0 then offset
  else
    match Unix.read descriptor buffer offset length with
    | 0 -> offset
    | read -> really_read descriptor buffer (offset + read) (length - read)

(* Whether the first [length] bytes of [source] are the whole of [target]. *)
let is_prefix ~source ~target length =
  with_reading source (fun from _ ->
      with_reading target (fun other _ ->
          let left = Bytes.create chunk and right = Bytes.create chunk in
          let rec compare remaining =
            if remaining = 0 then true
            else
              let wanted = min chunk remaining in
              let a = really_read from left 0 wanted in
              let b = really_read other right 0 wanted in
              a = wanted && b = wanted
              && Bytes.sub left 0 wanted = Bytes.sub right 0 wanted
              && compare (remaining - wanted)
          in
          Ok (compare length)))

(* The folders of [relative]'s path in the target exist as plain folders of
   the operator's, or are missing (then created). *)
let check_target_folders ~uid ~target relative =
  let components = String.split_on_char '/' (Filename.dirname relative) in
  let* _ =
    List.fold_left
      (fun acc component ->
        let* prefix = acc in
        let path = if prefix = "" then component else prefix ^ "/" ^ component in
        let* stats = lstat_opt (join target path) in
        match stats with
        | None -> Ok path
        | Some { Unix.st_kind = Unix.S_DIR; st_uid; _ } when st_uid = uid -> Ok path
        | Some _ -> fail "unsafe_entry" ("target " ^ path ^ " is not a plain folder"))
      (Ok "") components
  in
  Ok ()

let plan ~uid ~source ~target (relative, size) =
  let* () = check_target_folders ~uid ~target relative in
  let* existing = lstat_opt (join target relative) in
  match existing with
  | None -> Ok (relative, size, Copy)
  | Some { Unix.st_kind = Unix.S_REG; st_uid; st_size; _ } when st_uid = uid ->
      let* prefix =
        if st_size > size then Ok false
        else is_prefix ~source:(join source relative) ~target:(join target relative) st_size
      in
      if prefix && st_size = size then Ok (relative, size, Same)
      else if prefix then Ok (relative, size, Replace)
      else
        fail "conversation_diverged"
          ("the target holds a different copy of " ^ relative)
  | Some _ -> fail "unsafe_entry" ("target " ^ relative ^ " is not a regular file")

(* ----------------------------------------------------------- the writing *)

type state = {
  mutable created : string list;  (** folders made, newest first *)
  mutable temporary : string list;
  mutable committed : (string * string option) list;  (** final, backup *)
}

let token () =
  let state = Random.State.make_self_init () in
  Printf.sprintf "%08x%08x" (Random.State.bits state) (Random.State.bits state)

let sibling path tag =
  join (Filename.dirname path) (Printf.sprintf ".%s.carry-%s-%s" (Filename.basename path) tag (token ()))

let make_folders ~uid state ~target relative =
  List.fold_left
    (fun acc component ->
      let* prefix = acc in
      let path = if prefix = "" then component else prefix ^ "/" ^ component in
      let full = join target path in
      match Unix.mkdir full 0o700 with
      | () -> (
          state.created <- full :: state.created;
          match Unix.lstat full with
          | { Unix.st_kind = Unix.S_DIR; st_uid; _ } when st_uid = uid -> Ok path
          | _ -> fail "unsafe_entry" ("target " ^ path ^ " changed"))
      | exception Unix.Unix_error (Unix.EEXIST, _, _) -> (
          match Unix.lstat full with
          | { Unix.st_kind = Unix.S_DIR; st_uid; _ } when st_uid = uid -> Ok path
          | _ -> fail "unsafe_entry" ("target " ^ path ^ " is not a plain folder"))
      | exception Unix.Unix_error (error, _, _) ->
          fail "carry_failed" (path ^ ": " ^ Unix.error_message error))
    (Ok "")
    (String.split_on_char '/' (Filename.dirname relative))

let rec write_all io descriptor buffer offset length =
  if length > 0 then
    let written = io.write descriptor buffer offset length in
    write_all io descriptor buffer (offset + written) (length - written)

(* Copy [source] to a new temporary file next to [final]; its size must still
   be the planned one. *)
let stage io state ~source ~final size =
  let temporary = sibling final "new" in
  with_reading source (fun from stats ->
      if stats.Unix.st_size <> size then
        fail "carry_failed" "the conversation changed during the copy"
      else
        let* () =
          with_new_file temporary (fun into ->
              state.temporary <- temporary :: state.temporary;
              let buffer = Bytes.create chunk in
              let rec copy () =
                match Unix.read from buffer 0 chunk with
                | 0 -> ()
                | read ->
                    write_all io into buffer 0 read;
                    copy ()
              in
              copy ();
              Unix.fsync into;
              Ok ())
        in
        Ok temporary)

let commit io state ~final ~temporary action =
  let backup = if action = Replace then Some (sibling final "old") else None in
  Option.iter (fun backup -> io.rename final backup) backup;
  (match io.rename temporary final with
  | () -> ()
  | exception error ->
      Option.iter (fun backup -> Unix.rename backup final) backup;
      raise error);
  state.temporary <- List.filter (( <> ) temporary) state.temporary;
  state.committed <- (final, backup) :: state.committed

let quietly f = try f () with Unix.Unix_error _ | Sys_error _ -> ()

(* Undo everything, newest first: a replaced copy is put back. *)
let roll_back state =
  List.iter
    (fun (final, backup) ->
      match backup with
      | Some backup -> quietly (fun () -> Unix.rename backup final)
      | None -> quietly (fun () -> Unix.unlink final))
    state.committed;
  List.iter (fun path -> quietly (fun () -> Unix.unlink path)) state.temporary;
  List.iter (fun path -> quietly (fun () -> Unix.rmdir path)) state.created

let write_plan io ~uid ~source ~target planned =
  let state = { created = []; temporary = []; committed = [] } in
  let run () =
    let* staged =
      List.fold_left
        (fun acc (relative, size, action) ->
          let* acc = acc in
          if action = Same then Ok acc
          else
            let* _ = make_folders ~uid state ~target relative in
            let final = join target relative in
            let* temporary = stage io state ~source:(join source relative) ~final size in
            Ok ((final, temporary, action) :: acc))
        (Ok []) planned
    in
    List.iter
      (fun (final, temporary, action) -> commit io state ~final ~temporary action)
      (List.rev staged);
    Ok ()
  in
  match run () with
  | Ok () ->
      List.iter
        (fun (_, backup) -> Option.iter (fun b -> quietly (fun () -> Unix.unlink b)) backup)
        state.committed;
      Ok ()
  | Error error ->
      roll_back state;
      Error error
  | exception Unix.Unix_error (error, _, _) ->
      roll_back state;
      fail "carry_failed" (Unix.error_message error)

let carry ?(io = default_io) ~uid ~kind ~conversation ~source ~target () =
  if not (valid_conversation_id conversation) then
    fail "conversation_unknown" "not a conversation id"
  else
    let* () = existing_folder ~uid source in
    let* () = existing_folder ~uid target in
    let same =
      match (Unix.stat source, Unix.stat target) with
      | a, b -> a.st_dev = b.st_dev && a.st_ino = b.st_ino
      | exception Unix.Unix_error _ -> source = target
    in
    if same then fail "account_same" "both accounts use the same folder"
    else
      let* files =
        match kind with
        | Claude -> Carry_locate.claude_files ~uid ~source conversation
        | Codex -> Carry_locate.codex_files ~uid ~source conversation
      in
      let* planned =
        List.fold_left
          (fun acc file ->
            let* acc = acc in
            let* entry = plan ~uid ~source ~target file in
            Ok (entry :: acc))
          (Ok []) files
      in
      let planned = List.rev planned in
      let* () = write_plan io ~uid ~source ~target planned in
      let count wanted = List.length (List.filter (fun (_, _, a) -> a = wanted) planned) in
      Ok
        {
          files = List.length planned;
          copied = count Copy;
          replaced = count Replace;
          unchanged = count Same;
          bytes =
            List.fold_left
              (fun total (_, size, action) -> if action = Same then total else total + size)
              0 planned;
        }

let outcome_to_json outcome =
  `Assoc
    [
      ("files", `Int outcome.files);
      ("copied", `Int outcome.copied);
      ("replaced", `Int outcome.replaced);
      ("unchanged", `Int outcome.unchanged);
      ("bytes", `Int outcome.bytes);
    ]
