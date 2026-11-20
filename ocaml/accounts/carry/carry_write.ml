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
  mutable created : string list;  (** folders made, newest first *)
  mutable temporary : string list;
  mutable committed : (string * string * string option) list;
      (** relative, final, backup *)
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
        state.created <- full :: state.created;
        Ok ()
    | exception Unix.Unix_error (Unix.EEXIST, _, _) -> Ok ()
    | exception Unix.Unix_error (error, _, _) ->
        fail "carry_failed" (path ^ ": " ^ Unix.error_message error)
  in
  let* stats = lstat_opt full in
  match stats with
  | None -> fail "carry_failed" ("target " ^ path ^ " went away")
  | Some stats -> private_folder ~uid ("target " ^ path) stats

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

let commit io state ~target (relative, temporary, action) =
  let final = join target relative in
  let backup = if action = Replace then Some (sibling final "old") else None in
  Option.iter (fun backup -> io.rename final backup) backup;
  (match io.rename temporary final with
  | () -> ()
  | exception error ->
      Option.iter (restore io ~relative ~final) backup;
      raise error);
  state.temporary <- List.filter (( <> ) temporary) state.temporary;
  state.committed <- (relative, final, backup) :: state.committed

(* What a rollback could not undo, relative to the target: replaced copies
   that could not be put back (kept under their .carry-old name), and new
   copies that could not be removed. *)
type undone = { kept : string list; left : string list }

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
          { undone with kept = relative_sibling relative backup :: undone.kept }
      )

(* Undo everything, newest first, and report what could not be undone. *)
let roll_back io state =
  let undone =
    List.fold_left (undo io) { kept = []; left = [] } state.committed
  in
  List.iter (fun path -> quietly (fun () -> Unix.unlink path)) state.temporary;
  List.iter (fun path -> quietly (fun () -> Unix.rmdir path)) state.created;
  undone

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
let incomplete error { kept; left } =
  let not_removed =
    if left = [] then ""
    else "; new copies could not be removed: " ^ String.concat ", " left
  in
  match (kept, left) with
  | [], [] -> Error error
  | [], _ ->
      fail "carry_rollback_incomplete"
        ("the carry failed" ^ not_removed ^ " (" ^ error.message ^ ")")
  | _ ->
      fail "carry_restore_failed"
        ("the carry failed and an older copy could not be put back; it is kept \
          as " ^ String.concat ", " kept ^ not_removed)

let write_plan io ~uid ~source ~target planned =
  let state = { created = []; temporary = []; committed = [] } in
  let failed error = incomplete error (roll_back io state) in
  let unix error =
    { code = "carry_failed"; message = Unix.error_message error }
  in
  match
    let* staged = stage_all io ~uid state ~source ~target planned in
    List.iter (commit io state ~target) (List.rev staged);
    Ok ()
  with
  | Ok () ->
      List.iter
        (fun (_, _, backup) ->
          Option.iter (fun b -> quietly (fun () -> Unix.unlink b)) backup)
        state.committed;
      Ok ()
  | Error error -> failed error
  | exception Restore_failed kept ->
      let undone = roll_back io state in
      incomplete
        { code = "carry_failed"; message = "a rename failed" }
        { undone with kept = kept :: undone.kept }
  | exception Unix.Unix_error (error, _, _) -> failed (unix error)
  | exception Fun.Finally_raised (Unix.Unix_error (error, _, _)) ->
      failed (unix error)
  | exception error ->
      failed { code = "carry_failed"; message = Printexc.to_string error }
