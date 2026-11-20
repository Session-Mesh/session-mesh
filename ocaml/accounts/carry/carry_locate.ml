(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Finding the files of one conversation in an account folder. *)

open Carry_base

(* A private folder ({!Carry_base.private_folder}): [Ok None] when absent. *)
let directory_opt ~uid path relative =
  let* found = lstat_opt path in
  match found with
  | None -> Ok None
  | Some stats ->
      let* () = private_folder ~uid relative stats in
      Ok (Some ())

(* A regular file of the operator's with no other name (a hard link to a file
   elsewhere is refused) and not named as a login file. *)
let regular_file ~uid relative (stats : Unix.stats) =
  if stats.st_kind <> Unix.S_REG then
    fail "unsafe_entry" (relative ^ " is a link or not a regular file")
  else if stats.st_uid <> uid then
    fail "unsafe_entry" (relative ^ " is not the operator's")
  else if stats.st_nlink > 1 then
    fail "unsafe_entry" (relative ^ " has another name (a hard link)")
  else if is_login_file (Filename.basename relative) then
    fail "unsafe_entry" (relative ^ " is named as a login file")
  else Ok stats.st_size

(* One entry of a conversation's folder: a file is added, a folder walked; a
   carry's own temporary file is left out. *)
let rec walk_entry ~uid ~source ~seen relative depth acc name =
  let child = relative ^ "/" ^ name in
  incr seen;
  if !seen > max_entries then
    fail "conversation_too_large" "the conversation holds too many files"
  else if Option.is_some (carry_temporary name) then Ok acc
  else
    let* stats = lstat_opt (join source child) in
    match stats with
    | None -> Ok acc
    | Some { Unix.st_kind = Unix.S_DIR; _ } ->
        walk ~uid ~source ~seen child (depth + 1) acc
    | Some stats ->
        let* size = regular_file ~uid child stats in
        Ok ((child, size) :: acc)

(* The files under [relative] (a folder of the conversation), depth first;
   [seen] counts the entries looked at. *)
and walk ~uid ~source ~seen relative depth acc =
  if depth > max_depth then fail "unsafe_entry" (relative ^ " is too deep")
  else
    let* names = readdir (join source relative) in
    List.fold_left
      (fun acc name ->
        let* acc = acc in
        walk_entry ~uid ~source ~seen relative depth acc name)
      (Ok acc) names

let one_match = function
  | [ found ] -> Ok found
  | [] -> fail "conversation_not_found" "no such conversation"
  | _ -> fail "conversation_ambiguous" "several conversations have this id"

(* Every folder above the files found, from the account folder down, is a
   private folder. *)
let check_folders ~uid ~source files =
  let seen = Hashtbl.create 16 in
  let check folder =
    if Hashtbl.mem seen folder then Ok ()
    else begin
      Hashtbl.add seen folder ();
      let* stats = lstat_opt (join source folder) in
      match stats with
      | None -> fail "carry_failed" (folder ^ " went away")
      | Some stats -> private_folder ~uid folder stats
    end
  in
  List.fold_left
    (fun acc (relative, _) ->
      List.fold_left
        (fun acc folder ->
          let* () = acc in
          check folder)
        acc (parents relative))
    (Ok ()) files

(* The transcript [<id>.jsonl] in the project folder [name], if any. *)
let transcript_in ~uid ~source id name =
  let project = "projects/" ^ name in
  let transcript = project ^ "/" ^ id ^ ".jsonl" in
  let* folder = lstat_opt (join source project) in
  match folder with
  | Some { Unix.st_kind = Unix.S_DIR; _ } -> (
      let* stats = lstat_opt (join source transcript) in
      match stats with
      | None -> Ok None
      | Some stats ->
          let* size = regular_file ~uid transcript stats in
          Ok (Some (project, (transcript, size))))
  | _ -> Ok None

(* Claude: the project folders of projects/ holding <id>.jsonl. *)
let claude_files ~uid ~source id =
  let* projects = directory_opt ~uid (join source "projects") "projects" in
  let* names =
    if projects = None then Ok [] else readdir (join source "projects")
  in
  let* found =
    List.fold_left
      (fun acc name ->
        let* acc = acc in
        let* found = transcript_in ~uid ~source id name in
        Ok (Option.to_list found @ acc))
      (Ok []) names
  in
  let* project, transcript = one_match found in
  let own = project ^ "/" ^ id in
  let* folder = directory_opt ~uid (join source own) own in
  let* files =
    match folder with
    | None -> Ok [ transcript ]
    | Some () ->
        let* files = walk ~uid ~source ~seen:(ref 0) own 1 [] in
        Ok (transcript :: List.rev files)
  in
  let* () = check_folders ~uid ~source files in
  Ok files

(* The plain folders of [relative]; a folder that is a link is not one. *)
let subfolders ~source relative =
  let* names = readdir (join source relative) in
  Ok
    (List.filter_map
       (fun name ->
         let child = relative ^ "/" ^ name in
         match Unix.lstat (join source child) with
         | { Unix.st_kind = Unix.S_DIR; _ } -> Some child
         | _ | (exception Unix.Unix_error _) -> None)
       names)

(* The folders [levels] below [relatives]: sessions/YYYY/MM/DD. *)
let rec down ~source relatives levels =
  if levels = 0 then Ok relatives
  else
    let* next =
      List.fold_left
        (fun acc relative ->
          let* acc = acc in
          let* children = subfolders ~source relative in
          Ok (acc @ children))
        (Ok []) relatives
    in
    down ~source next (levels - 1)

(* Exactly [rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl]: a name that merely ends
   with the id is another conversation's. *)
let is_rollout_of id name =
  let prefix = "rollout-" and suffix = "-" ^ id ^ ".jsonl" in
  let stamp = "dddd-dd-ddTdd-dd-dd" in
  String.length name
  = String.length prefix + String.length stamp + String.length suffix
  && String.starts_with ~prefix name
  && String.ends_with ~suffix name
  && has_shape stamp
       (String.sub name (String.length prefix) (String.length stamp))

(* The rollouts of conversation [id] in one day folder, added to [acc]. *)
let rollouts_of ~uid ~source id day acc =
  let* names = readdir (join source day) in
  List.fold_left
    (fun acc name ->
      let* acc = acc in
      if not (is_rollout_of id name) then Ok acc
      else
        let rollout = day ^ "/" ^ name in
        let* stats = lstat_opt (join source rollout) in
        match stats with
        | None -> Ok acc
        | Some stats ->
            let* size = regular_file ~uid rollout stats in
            Ok ((rollout, size) :: acc))
    (Ok acc) names

(* Codex: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, [id] a UUID. *)
let codex_files ~uid ~source id =
  let* sessions = directory_opt ~uid (join source "sessions") "sessions" in
  let* days =
    if sessions = None then Ok [] else down ~source [ "sessions" ] 3
  in
  let* found =
    List.fold_left
      (fun acc day ->
        let* acc = acc in
        rollouts_of ~uid ~source id day acc)
      (Ok []) days
  in
  let* rollout = one_match found in
  let* () = check_folders ~uid ~source [ rollout ] in
  Ok [ rollout ]
