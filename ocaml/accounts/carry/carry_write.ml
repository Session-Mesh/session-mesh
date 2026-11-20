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

(* What to do with one file; the target's folders passed
   {!Carry_target.check_folders}. *)
let plan ~uid ~source ~target (relative, size) =
  let* existing = lstat_opt (join target relative) in
  match existing with
  | None -> Ok (relative, size, Copy)
  | Some { Unix.st_kind = Unix.S_REG; st_uid; st_size; _ } when st_uid = uid ->
      let* prefix =
        if st_size > size then Ok false
        else
          is_prefix ~source:(join source relative)
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

(* Copy [source] to a new temporary file next to [final]; its size must still
   be the planned one. *)
let stage io state ~source ~final size =
  let temporary = sibling final "new" in
  with_reading source (fun from stats ->
      if stats.Unix.st_size <> size then
        fail "carry_failed" "the conversation changed during the copy"
      else
        let* () =
          with_new_file io temporary (fun into ->
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

(* Undo everything, newest first: a replaced copy is put back. The replaced
   copies that could not be put back are returned, relative to the target. *)
let roll_back io state =
  let kept =
    List.filter_map
      (fun (relative, final, backup) ->
        match backup with
        | None ->
            quietly (fun () -> Unix.unlink final);
            None
        | Some backup -> (
            match io.rename backup final with
            | () -> None
            | exception _ -> Some (relative_sibling relative backup)))
      state.committed
  in
  List.iter (fun path -> quietly (fun () -> Unix.unlink path)) state.temporary;
  List.iter (fun path -> quietly (fun () -> Unix.rmdir path)) state.created;
  kept

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

let restore_failed kept =
  fail "carry_restore_failed"
    ("the carry failed and an older copy could not be put back; it is kept as "
   ^ String.concat ", " kept)

let write_plan io ~uid ~source ~target planned =
  let state = { created = []; temporary = []; committed = [] } in
  let failed error =
    match roll_back io state with
    | [] -> Error error
    | kept -> restore_failed kept
  in
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
  | exception Restore_failed kept -> restore_failed (kept :: roll_back io state)
  | exception Unix.Unix_error (error, _, _) -> failed (unix error)
  | exception Fun.Finally_raised (Unix.Unix_error (error, _, _)) ->
      failed (unix error)
  | exception error ->
      failed { code = "carry_failed"; message = Printexc.to_string error }
