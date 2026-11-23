(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Comparing the conversation's files with the target's copies, then writing
   them all or nothing. *)

open Carry_base

type io = {
  write : Unix.file_descr -> bytes -> int -> int -> int;
  read : Unix.file_descr -> bytes -> int -> int -> int;
  unlink : string -> unit;
  rename : string -> string -> unit;
  close : Unix.file_descr -> unit;
  free_bytes : string -> int option;
}

type action = Copy | Replace | Same

(* A regular file read without following a link (Mesh_safe_file). *)
let with_reading path f =
  match Mesh_safe_file.with_regular path f with
  | Ok result -> result
  | Error error -> fail "carry_failed" (Mesh_safe_file.error_message error)

(* A new file: O_EXCL with O_CREAT never follows a link, nor opens a file
   someone put there first. A failing close raises [Fun.Finally_raised]. *)
let with_new_file io path f =
  match
    Unix.openfile path
      [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
      0o600
  with
  | exception Unix.Unix_error (error, _, _) ->
      fail "carry_failed" (Unix.error_message error)
  | descriptor ->
      Fun.protect
        ~finally:(fun () -> io.close descriptor)
        (fun () -> f descriptor)

let rec really_read io descriptor buffer offset length =
  if length = 0 then offset
  else
    match io.read descriptor buffer offset length with
    | 0 -> offset
    | read -> really_read io descriptor buffer (offset + read) (length - read)

(* Whether the first [length] bytes of [source] are the whole of [target]; a
   file that ends early is not a prefix, a failed read a refusal. *)
let is_prefix io ~source ~target length =
  let compare_files from other =
    let left = Bytes.create chunk and right = Bytes.create chunk in
    let rec compare remaining =
      if remaining = 0 then true
      else
        let wanted = min chunk remaining in
        let a = really_read io from left 0 wanted in
        let b = really_read io other right 0 wanted in
        a = wanted && b = wanted
        && Bytes.sub left 0 wanted = Bytes.sub right 0 wanted
        && compare (remaining - wanted)
    in
    compare length
  in
  match
    with_reading source (fun from _ ->
        with_reading target (fun other _ -> Ok (compare_files from other)))
  with
  | result -> result
  | exception Unix.Unix_error (error, _, _) ->
      fail "carry_failed"
        ("comparing with the target's copy: " ^ Unix.error_message error)

(* What to do with one file; the target's folders passed
   {!Carry_target.check_folders}. A copy that group or others can write is
   never compared nor replaced: it could change in between. *)
let plan io ~uid ~source ~target (relative, size) =
  let* existing = lstat_opt (join target relative) in
  match existing with
  | None -> Ok (relative, size, Copy)
  | Some { Unix.st_kind = Unix.S_REG; st_uid; st_perm; _ }
    when st_uid = uid && st_perm land 0o022 <> 0 ->
      fail "unsafe_entry"
        ("target " ^ relative ^ " can be written by other users")
  | Some { Unix.st_kind = Unix.S_REG; st_uid; st_nlink; _ }
    when st_uid = uid && st_nlink <> 1 ->
      fail "unsafe_entry"
        ("target " ^ relative ^ " has another name (a hard link)")
  | Some { Unix.st_kind = Unix.S_REG; st_uid; st_size; _ } when st_uid = uid ->
      let* prefix =
        if st_size > size then Ok false
        else
          is_prefix io ~source:(join source relative)
            ~target:(join target relative) st_size
      in
      if prefix && st_size = size then Ok (relative, size, Same)
      else if prefix then Ok (relative, size, Replace)
      else
        fail "conversation_diverged"
          ("the target holds a different copy of " ^ relative)
  | Some _ ->
      fail "unsafe_entry" ("target " ^ relative ^ " is not a regular file")

(* ----------------------------------------------------------- the writing *)

type state = {
  mutable created : (string * Unix.stats) list;  (** proven custody, newest first *)
  mutable unproven_folders : string list;
  mutable temporary : string list;
  mutable committed : (string * string * string option) list;
      (** relative, final, backup *)
  mutable inflight : (string * string * string * string option) option;
      (** The rename currently attempted: record its possible effects first. *)
}

(* A replaced copy could not be put back; it is kept under this name,
   relative to the target. *)
exception Restore_failed of string

let token () =
  let state = Random.State.make_self_init () in
  Printf.sprintf "%08x%08x" (Random.State.bits state) (Random.State.bits state)

let sibling path tag =
  join (Filename.dirname path)
    (Printf.sprintf ".%s.carry-%s-%s" (Filename.basename path) tag (token ()))

let relative_sibling relative path =
  match Filename.dirname relative with
  | "." -> Filename.basename path
  | folder -> folder ^ "/" ^ Filename.basename path

let make_folder ~uid state ~target path =
  let full = join target path in
  let* () =
    match Unix.mkdir full 0o700 with
    | () ->
        (* mkdir returns no identity. A later lookup may name a different
           directory; retain it for review rather than granting rmdir rights. *)
        state.unproven_folders <- full :: state.unproven_folders;
        Ok ()
    | exception Unix.Unix_error (Unix.EEXIST, _, _) -> Ok ()
    | exception Unix.Unix_error (error, _, _) ->
        fail "carry_failed" (path ^ ": " ^ Unix.error_message error)
  in
  let* stats = lstat_opt full in
  match stats with
  | None -> fail "carry_failed" ("target " ^ path ^ " went away")
  | Some stats ->
      let* () = private_folder ~uid ("target " ^ path) stats in
      Ok ()

let make_folders ~uid state ~target relative =
  List.fold_left
    (fun acc path ->
      let* () = acc in
      make_folder ~uid state ~target path)
    (Ok ()) (parents relative)

let rec write_all io descriptor buffer offset length =
  if length > 0 then
    let written = io.write descriptor buffer offset length in
    write_all io descriptor buffer (offset + written) (length - written)

let changed () = fail "carry_failed" "the conversation changed during the copy"

(* Copy [source] to a new temporary file next to [final]; its size must still
   be the planned one, when opened and in the bytes copied. *)
let stage io state ~source ~final size =
  let temporary = sibling final "new" in
  with_reading source (fun from stats ->
      if stats.Unix.st_size <> size then changed ()
      else
        let* () =
          with_new_file io temporary (fun into ->
              state.temporary <- temporary :: state.temporary;
              let buffer = Bytes.create chunk in
              let rec copy total =
                match io.read from buffer 0 chunk with
                | 0 -> total
                | read ->
                    write_all io into buffer 0 read;
                    copy (total + read)
              in
              let copied = copy 0 in
              Unix.fsync into;
              if copied <> size then changed () else Ok ())
        in
        Ok temporary)

(* Put [backup] back as [final] after a failed rename, or raise
   [Restore_failed]. *)
let restore io ~relative ~final backup =
  match io.rename backup final with
  | () -> ()
  | exception _ -> raise (Restore_failed (relative_sibling relative backup))

let commit ~check_roots io state ~target (relative, temporary, action) =
  let final = join target relative in
  let backup = if action = Replace then Some (sibling final "old") else None in
  state.inflight <- Some (relative, temporary, final, backup);
  Option.iter (fun backup -> io.rename final backup) backup;
  (match io.rename temporary final with
  | () -> ()
  | exception error ->
      if Result.is_ok (check_roots ()) then
        Option.iter (restore io ~relative ~final) backup;
      raise error);
  state.temporary <- List.filter (( <> ) temporary) state.temporary;
  state.committed <- (relative, final, backup) :: state.committed;
  state.inflight <- None

(* What a rollback could not undo or verify, relative to the target. *)
type undone = {
  kept : string list;
  left : string list;
  temporary : string list;
  folders : string list;
  uncertain : string list;
}

let empty_undone =
  { kept = []; left = []; temporary = []; folders = []; uncertain = [] }

let relative_to_target ~target path =
  let prefix = target ^ "/" in
  if String.starts_with ~prefix path then
    String.sub path (String.length prefix)
      (String.length path - String.length prefix)
  else Filename.basename path

let possible_rename_paths (relative, _, backup) =
  relative :: Option.to_list (Option.map (relative_sibling relative) backup)

let possible_effects state =
  let inflight =
    Option.to_list
      (Option.map
         (fun (relative, _, final, backup) -> (relative, final, backup))
         state.inflight)
  in
  List.concat_map possible_rename_paths (inflight @ state.committed)
  |> List.sort_uniq String.compare

let pending_cleanup ~target (state : state) =
  {
    empty_undone with
    temporary = List.map (relative_to_target ~target) state.temporary;
    folders =
      List.map (relative_to_target ~target)
        (state.unproven_folders @ List.map fst state.created);
    uncertain = possible_effects state;
  }

(* If a rename raised before its effects could be observed, a stable root can
   still show whether it moved anything. Missing/unreadable names are not
   assumed clean. Never inspect a replacement root: callers check custody
   before calling this function. *)
let unresolved_rename state =
  let exists path =
    match Unix.lstat path with
    | _ -> true
    | exception Unix.Unix_error (Unix.ENOENT, _, _) -> false
    | exception Unix.Unix_error _ -> true
  in
  match state.inflight with
  | None -> []
  | Some (relative, _, final, None) ->
      if exists final then [ relative ] else []
  | Some (relative, temporary, _, Some backup) ->
      if exists backup || not (exists temporary) then
        [ relative; relative_sibling relative backup ]
      else []

(* Undo one file put in place: remove a new copy, put a replaced one back. *)
let undo io undone (relative, final, backup) =
  match backup with
  | None -> (
      match io.unlink final with
      | () -> undone
      | exception _ -> { undone with left = relative :: undone.left })
  | Some backup -> (
      match io.rename backup final with
      | () -> undone
      | exception _ ->
          {
            undone with
            kept = relative_sibling relative backup :: undone.kept;
            uncertain = relative :: undone.uncertain;
          }
      )

(* Undo everything, newest first, and report skipped as well as failed cleanup. *)
let roll_back ?(check_roots = fun () -> Ok ()) io ~target state =
  let undone =
    List.fold_left
      (fun undone entry ->
        if Result.is_ok (check_roots ()) then undo io undone entry
        else
          {
            undone with
            uncertain = possible_rename_paths entry @ undone.uncertain;
          })
      empty_undone state.committed
  in
  let undone =
    List.fold_left
      (fun undone path ->
        let removed =
          Result.is_ok (check_roots ())
          && (match io.unlink path with () -> true | exception _ -> false)
        in
        if removed then undone
        else
          {
            undone with
            temporary = relative_to_target ~target path :: undone.temporary;
          })
      undone state.temporary
  in
  let undone =
    List.fold_left
      (fun undone (path, identity) ->
        let removed =
          Result.is_ok (check_roots ())
          && Carry_target.same_directory ~target:path identity
          && (match Unix.rmdir path with () -> true | exception _ -> false)
        in
        if removed then undone
        else
          { undone with folders = relative_to_target ~target path :: undone.folders })
      undone state.created
  in
  { undone with
    folders =
      List.map (relative_to_target ~target) state.unproven_folders
      @ undone.folders }

let stage_all io ~uid state ~source ~target planned =
  List.fold_left
    (fun acc (relative, size, action) ->
      let* acc = acc in
      if action = Same then Ok acc
      else
        let* () = make_folders ~uid state ~target relative in
        let* temporary =
          stage io state ~source:(join source relative)
            ~final:(join target relative) size
        in
        Ok ((relative, temporary, action) :: acc))
    (Ok []) planned

(* The refusal of a failed carry whose rollback was incomplete: an older copy
   not put back weighs more than a new copy not removed. *)
let cleanup_details { kept = _; left; temporary; folders; uncertain } =
  let not_removed =
    if left = [] then ""
    else "; new copies could not be removed: " ^ String.concat ", " left
  in
  let staged =
    if temporary = [] then ""
    else "; staged copy cleanup unconfirmed: " ^ String.concat ", " temporary
  in
  let created =
    if folders = [] then ""
    else "; folder cleanup unconfirmed: " ^ String.concat ", " folders
  in
  let effects =
    if uncertain = [] then ""
    else
      "; installed copies or backups unconfirmed: "
      ^ String.concat ", " uncertain
  in
  not_removed ^ staged ^ created ^ effects

let incomplete error ({ kept; left; temporary; folders; uncertain } as undone) =
  let details = cleanup_details undone in
  match (kept, left, temporary, folders, uncertain) with
  | [], [], [], [], [] -> Error error
  | [], _, _, _, _ ->
      fail "carry_rollback_incomplete"
        ("the carry failed" ^ details ^ " (" ^ error.message ^ ")")
  | _ ->
      fail "carry_restore_failed"
        ("the carry failed and an older copy could not be put back; it is kept \
          as " ^ String.concat ", " kept ^ details)

let write_plan ?(check_roots = fun () -> Ok ())
    ?(validate_staged = fun _ -> Ok ()) io ~uid ~source ~target planned =
  let state =
    { created = []; unproven_folders = []; temporary = []; committed = [];
      inflight = None }
  in
  let root_changed undone =
    let uncertain =
      List.sort_uniq String.compare (possible_effects state @ undone.uncertain)
    in
    fail "carry_rollback_incomplete"
      ("an account folder changed during the copy; cleanup requires review"
      ^ cleanup_details { undone with uncertain })
  in
  let failed error =
    match check_roots () with
    | Ok () ->
        let uncertain = unresolved_rename state in
        let undone = roll_back ~check_roots io ~target state in
        let undone =
          { undone with
            uncertain = List.sort_uniq String.compare (uncertain @ undone.uncertain) }
        in
        (match check_roots () with
        | Ok () -> incomplete error undone
        | Error _ -> root_changed undone)
    | Error _ -> root_changed (pending_cleanup ~target state)
  in
  let unix error =
    { code = "carry_failed"; message = Unix.error_message error }
  in
  let rec discard_backups = function
    | [] -> (
        match check_roots () with
        | Ok () -> Ok ()
        | Error _ -> root_changed (pending_cleanup ~target state))
    | (_, _, None) :: rest -> discard_backups rest
    | (_, _, Some backup) :: rest -> (
        match check_roots () with
        | Error _ -> root_changed (pending_cleanup ~target state)
        | Ok () ->
            match io.unlink backup with
            | () -> discard_backups rest
            | exception _ ->
                let pending = pending_cleanup ~target state in
                (match check_roots () with
                | Error _ -> root_changed pending
                | Ok () ->
                    fail "carry_rollback_incomplete"
                      ("the carry was installed but backup cleanup requires \
                        review"
                      ^ cleanup_details pending)))
  in
  match
    let* staged = stage_all io ~uid state ~source ~target planned in
    let* () = validate_staged staged in
    List.iter (commit ~check_roots io state ~target) (List.rev staged);
    Ok ()
  with
  | Ok () ->
      (match check_roots () with
      | Error _ -> root_changed (pending_cleanup ~target state)
      | Ok () -> discard_backups state.committed)
  | Error error -> failed error
  | exception Restore_failed kept ->
      (match check_roots () with
      | Error _ -> root_changed (pending_cleanup ~target state)
      | Ok () ->
          let undone = roll_back ~check_roots io ~target state in
          (match check_roots () with
       | Error _ -> root_changed undone
       | Ok () ->
           incomplete
             { code = "carry_failed"; message = "a rename failed" }
             {
               undone with
               kept = kept :: undone.kept;
               uncertain = possible_effects state @ undone.uncertain;
             }))
  | exception Unix.Unix_error (error, _, _) -> failed (unix error)
  | exception Fun.Finally_raised (Unix.Unix_error (error, _, _)) ->
      failed (unix error)
  | exception error ->
      failed { code = "carry_failed"; message = Printexc.to_string error }
