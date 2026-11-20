(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Finding the files of one conversation in an account folder. *)

open Carry_base


(* A directory that is not a link: [Ok None] when absent. *)
let directory_opt path relative =
  let* found = lstat_opt path in
  match found with
  | None -> Ok None
  | Some { Unix.st_kind = Unix.S_DIR; _ } -> Ok (Some ())
  | Some _ -> fail "unsafe_entry" (relative ^ " is not a plain folder")

let regular_file ~uid relative (stats : Unix.stats) =
  if stats.st_kind <> Unix.S_REG then
    fail "unsafe_entry" (relative ^ " is a link or not a regular file")
  else if stats.st_uid <> uid then
    fail "unsafe_entry" (relative ^ " is not the operator's")
  else if List.mem (Filename.basename relative) login_files then
    fail "unsafe_entry" (relative ^ " is named as a login file")
  else Ok stats.st_size

(* The files under [relative] (a folder of the conversation), depth first;
   [seen] counts the entries looked at. *)
let rec walk ~uid ~source ~seen relative depth acc =
  if depth > max_depth then fail "unsafe_entry" (relative ^ " is too deep")
  else
    let* names = readdir (join source relative) in
    List.fold_left
      (fun acc name ->
        let* acc = acc in
        let child = relative ^ "/" ^ name in
        incr seen;
        if !seen > max_files then
          fail "unsafe_entry" "the conversation holds too many files"
        else
          let* stats = lstat_opt (join source child) in
          match stats with
          | None -> Ok acc
          | Some { Unix.st_kind = Unix.S_DIR; _ } ->
              walk ~uid ~source ~seen child (depth + 1) acc
          | Some stats ->
              let* size = regular_file ~uid child stats in
              Ok ((child, size) :: acc))
      (Ok acc) names

let one_match id = function
  | [ found ] -> Ok found
  | [] -> fail "conversation_not_found" ("no conversation " ^ id)
  | _ -> fail "conversation_ambiguous" ("several conversations " ^ id)

(* Claude: the project folders of projects/ holding <id>.jsonl. *)
let claude_files ~uid ~source id =
  let* projects = directory_opt (join source "projects") "projects" in
  match projects with
  | None -> fail "conversation_not_found" ("no conversation " ^ id)
  | Some () ->
      let* names = readdir (join source "projects") in
      let* found =
        List.fold_left
          (fun acc name ->
            let* acc = acc in
            let project = "projects/" ^ name in
            let transcript = project ^ "/" ^ id ^ ".jsonl" in
            let* folder = lstat_opt (join source project) in
            match folder with
            | Some { Unix.st_kind = Unix.S_DIR; _ } -> (
                let* stats = lstat_opt (join source transcript) in
                match stats with
                | None -> Ok acc
                | Some stats ->
                    let* size = regular_file ~uid transcript stats in
                    Ok ((project, (transcript, size)) :: acc))
            | _ -> Ok acc)
          (Ok []) names
      in
      let* project, transcript = one_match id found in
      let own = project ^ "/" ^ id in
      let* folder = directory_opt (join source own) own in
      match folder with
      | None -> Ok [ transcript ]
      | Some () ->
          let* files = walk ~uid ~source ~seen:(ref 0) own 1 [] in
          Ok (transcript :: List.rev files)

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

(* The rollouts of conversation [id] in one day folder, added to [acc]. *)
let rollouts_of ~uid ~source id day acc =
  let suffix = "-" ^ id ^ ".jsonl" in
  let* names = readdir (join source day) in
  List.fold_left
    (fun acc name ->
      let* acc = acc in
      if String.starts_with ~prefix:"rollout-" name && String.ends_with ~suffix name
      then
        let rollout = day ^ "/" ^ name in
        let* stats = lstat_opt (join source rollout) in
        match stats with
        | None -> Ok acc
        | Some stats ->
            let* size = regular_file ~uid rollout stats in
            Ok ((rollout, size) :: acc)
      else Ok acc)
    (Ok acc) names

(* Codex: sessions/YYYY/MM/DD/rollout-*-<id>.jsonl. *)
let codex_files ~uid ~source id =
  let* sessions = directory_opt (join source "sessions") "sessions" in
  match sessions with
  | None -> fail "conversation_not_found" ("no conversation " ^ id)
  | Some () ->
      let* days = down ~source [ "sessions" ] 3 in
      let* found =
        List.fold_left
          (fun acc day ->
            let* acc = acc in
            rollouts_of ~uid ~source id day acc)
          (Ok []) days
      in
      let* rollout = one_match id found in
      Ok [ rollout ]

