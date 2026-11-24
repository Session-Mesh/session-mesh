(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Pi's persisted conversation is one v3 JSONL file: the whole file, not an
   active-branch rendering or a compaction summary, is the resumable context. *)

open Carry_base

type error = Carry_base.error = { code : string; message : string }

type outcome = {
  files : int;
  copied : int;
  replaced : int;
  unchanged : int;
  bytes : int;
}

let default_io : Carry_write.io =
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

let invalid () =
  fail "conversation_invalid" "the Pi session is incomplete or malformed"

let unsupported () =
  fail "conversation_unsupported" "unsupported Pi session version or entry"

let required name fields =
  match List.assoc_opt name fields with Some value -> Ok value | None -> invalid ()

let text name fields =
  let* value = required name fields in
  match value with `String s when s <> "" -> Ok s | _ -> invalid ()

let object_fields = function
  | `Assoc fields ->
      let seen = Hashtbl.create (List.length fields) in
      if List.exists
           (fun (name, _) ->
             if Hashtbl.mem seen name then true
             else (Hashtbl.add seen name (); false))
           fields
      then invalid ()
      else Ok fields
  | _ -> invalid ()

let iso_time text =
  String.length text >= 19
  && has_shape "dddd-dd-ddTdd:dd:dd" (String.sub text 0 19)

let valid_entry_id id =
  has_shape "xxxxxxxx" id || valid_uuid id

let content = function `String _ | `List _ -> Ok () | _ -> invalid ()

let bash_message fields =
  let* command = required "command" fields in
  let* output = required "output" fields in
  let* cancelled = required "cancelled" fields in
  let* truncated = required "truncated" fields in
  let* timestamp = required "timestamp" fields in
  match
    ( command, output, List.assoc_opt "exitCode" fields, cancelled,
      truncated, timestamp, List.assoc_opt "fullOutputPath" fields,
      List.assoc_opt "excludeFromContext" fields )
  with
  | ( `String _, `String _, (None | Some (`Int _ | `Null)),
      `Bool _, `Bool _, `Int _,
      (None | Some (`String _)), (None | Some (`Bool _)) ) -> Ok ()
  | _ -> invalid ()

let entry ~seen json =
  let* fields = object_fields json in
  let* kind = text "type" fields in
  if kind = "session" then invalid ()
  else
    let* entry_id = text "id" fields in
    let* timestamp = text "timestamp" fields in
    let* parent = required "parentId" fields in
    let* () =
      if valid_entry_id entry_id && iso_time timestamp
         && not (Hashtbl.mem seen entry_id)
         && (match parent with
            | `Null -> true
            | `String parent -> Hashtbl.mem seen parent
            | _ -> false)
      then Ok ()
      else invalid ()
    in
    let known ?(self = false) key =
      let* value = text key fields in
      if Hashtbl.mem seen value || (self && value = entry_id) then Ok ()
      else invalid ()
    in
    let* () =
      match kind with
      | "message" ->
          let* message = required "message" fields in
          let* message_fields = object_fields message in
          let* role = text "role" message_fields in
          if role = "bashExecution" then bash_message message_fields
          else if
            List.mem role [ "system"; "user"; "assistant"; "toolResult"; "custom" ]
          then
            let* value = required "content" message_fields in
            content value
          else unsupported ()
      | "compaction" ->
          let* _ = text "summary" fields in
          let* tokens = required "tokensBefore" fields in
          let* () =
            match tokens with `Int n when n >= 0 -> Ok () | _ -> invalid ()
          in
          known ~self:true "firstKeptEntryId"
      | "branch_summary" ->
          let* _ = text "summary" fields in
          let* from_id = text "fromId" fields in
          if valid_entry_id from_id then Ok () else invalid ()
      | "context_edit" ->
          let* () = known "targetId" in
          let* replacement = required "replacement" fields in
          (match replacement with
          | `Null -> Ok ()
          | `Assoc fields -> let* value = required "content" fields in content value
          | _ -> invalid ())
      | "label" -> known "targetId"
      | "model_change" ->
          let* _ = text "provider" fields in
          let* _ = text "modelId" fields in
          Ok ()
      | "thinking_level_change" ->
          let* _ = text "thinkingLevel" fields in
          Ok ()
      | "usage" ->
          let* _ = text "kind" fields in
          Ok ()
      | "custom" | "custom_message" ->
          let* _ = text "customType" fields in
          if kind = "custom" then Ok ()
          else
            let* value = required "content" fields in
            content value
      | "session_info" ->
          (match List.assoc_opt "name" fields with
          | None | Some (`String _) -> Ok ()
          | _ -> invalid ())
      | _ -> unsupported ()
    in
    Hashtbl.add seen entry_id ();
    Ok ()

let header ~conversation json =
  let* fields = object_fields json in
  let* kind = text "type" fields in
  let* id = text "id" fields in
  let* version = required "version" fields in
  let* timestamp = text "timestamp" fields in
  let* _ = text "cwd" fields in
  if kind <> "session" || id <> conversation || not (iso_time timestamp)
  then invalid ()
  else match version with `Int 3 -> Ok () | _ -> unsupported ()

(* Parse a bounded file through a descriptor pinned by Mesh_safe_file. Require
   every line including the last to be terminated: an append in progress is
   never treated as a complete transcript. Hash every byte for the stage check. *)
let validate ~(io : Carry_write.io) ~uid ~conversation ~relative ~path ~maximum =
  let* stats = lstat_opt path in
  let* size =
    match stats with
    | None -> fail "conversation_not_found" "no such conversation"
    | Some stats -> Carry_locate.regular_file ~uid relative stats
  in
  if size > maximum then
    fail "conversation_too_large" "the Pi session exceeds the carry limit"
  else
    match
      Carry_write.with_reading path (fun fd opened ->
          let pending = Buffer.create 4096 in
          let seen = Hashtbl.create 64 in
          let lines = ref 0 in
          let hash = ref (Digestif.SHA256.init ()) in
          let max_line = min maximum (64 * mib) in
          let process line =
            if line = "" || !lines >= max_entries then invalid ()
            else
              let* json =
                match Yojson.Safe.from_string line with
                | value -> Ok value
                | exception Yojson.Json_error _ | exception Stack_overflow ->
                    invalid ()
              in
              let* () =
                if !lines = 0 then header ~conversation json
                else entry ~seen json
              in
              incr lines;
              Ok ()
          in
          let rec pieces = function
            | [] -> Ok ()
            | [ last ] ->
                Buffer.add_string pending last;
                if Buffer.length pending > max_line then invalid () else Ok ()
            | first :: rest ->
                Buffer.add_string pending first;
                let* () =
                  if Buffer.length pending > max_line then invalid ()
                  else process (Buffer.contents pending)
                in
                Buffer.clear pending;
                pieces rest
          in
          let buffer = Bytes.create chunk in
          let rec read_all total =
            let read = io.read fd buffer 0 chunk in
            if read = 0 then
              let* () =
                if total = size && Buffer.length pending = 0 && !lines > 1
                   && Carry_target.same_file opened (Unix.fstat fd)
                   && Carry_target.same_file opened (Unix.lstat path)
                   && (Unix.fstat fd).Unix.st_size = size
                then Ok ()
                else invalid ()
              in
              Ok (size, Digestif.SHA256.(to_hex (get !hash)))
            else if read > size - total then invalid ()
            else
              let data = Bytes.sub_string buffer 0 read in
              hash := Digestif.SHA256.feed_string !hash data;
              let* () = pieces (String.split_on_char '\n' data) in
              read_all (total + read)
          in
          read_all 0)
    with
    | result -> result
    | exception Unix.Unix_error _ ->
        fail "carry_failed" "reading the Pi session failed"
    | exception Sys_error _ -> fail "carry_failed" "reading the Pi session failed"

let timestamp name =
  String.length name >= 19
  && String.length name <= 36
  && has_shape "dddd-dd-ddTdd-dd-dd" (String.sub name 0 19)
  && String.for_all
       (function '0' .. '9' | '.' | '-' | 'Z' -> true | _ -> false)
       (String.sub name 19 (String.length name - 19))

let session_name conversation name =
  let suffix = "_" ^ conversation ^ ".jsonl" in
  String.ends_with ~suffix name
  && timestamp (String.sub name 0 (String.length name - String.length suffix))

let group_name name =
  String.length name >= 5 && String.length name <= 255
  && String.starts_with ~prefix:"--" name
  && String.ends_with ~suffix:"--" name
  && String.for_all
       (fun c -> Char.code c >= 0x20 && c <> '\127' && c <> '\\')
       name

let locate_matches ~uid ~source conversation =
  let* groups = readdir source in
  if List.length groups > max_entries then
    fail "conversation_too_large" "the sessions root holds too many entries"
  else
    let inspected = ref (List.length groups) in
    let* matches =
      List.fold_left
        (fun acc name ->
          let* acc = acc in
          if session_name conversation name then Ok (name :: acc)
          else if not (group_name name) then Ok acc
          else
            let* present = lstat_opt (join source name) in
            match present with
            | None -> invalid ()
            | Some stats ->
                let* () = private_folder ~uid name stats in
                let* names = readdir (join source name) in
                inspected := !inspected + List.length names;
                if !inspected > max_entries then
                  fail "conversation_too_large" "the sessions root holds too many entries"
                else
                  List.fold_left
                    (fun acc file ->
                      let* acc = acc in
                      if session_name conversation file then
                        Ok ((name ^ "/" ^ file) :: acc)
                      else Ok acc)
                    (Ok acc) names)
        (Ok []) groups
    in
    Ok matches

let locate ~uid ~source conversation =
  let* matches = locate_matches ~uid ~source conversation in
  match matches with
  | [] -> fail "conversation_not_found" "no such Pi conversation"
  | [ relative ] -> Ok relative
  | _ -> fail "conversation_ambiguous" "several Pi sessions have this id"

let checked_directory ~uid path =
  Result.map_error
    (fun message -> { code = "account_folder_refused"; message })
    (Mesh_accounts.check_directory ~uid path)

let with_bound ~uid path f =
  let* () = checked_directory ~uid path in
  let* seen = lstat_opt path in
  match seen with
  | Some seen when seen.Unix.st_kind = Unix.S_DIR -> (
      match Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 with
      | exception Unix.Unix_error _ ->
          fail "account_folder_refused" "the sessions root changed"
      | descriptor ->
          Fun.protect
            ~finally:(fun () -> Unix.close descriptor)
            (fun () ->
              match Unix.fstat descriptor with
              | opened
                when opened.Unix.st_kind = Unix.S_DIR
                     && Carry_target.same_file seen opened
                     && Carry_target.same_directory ~target:path opened ->
                  f opened
              | _ | (exception Unix.Unix_error _) ->
                  fail "account_folder_refused" "the sessions root changed"))
  | _ -> fail "account_folder_refused" "the sessions root is not a directory"

let check_bound ~uid path identity =
  if Carry_target.same_directory ~target:path identity then
    checked_directory ~uid path
  else fail "account_folder_refused" "the sessions root changed"

let check_distinct source target =
  match (Unix.realpath source, Unix.realpath target) with
  | source, target ->
      let within root other = String.starts_with ~prefix:(root ^ "/") other in
      if source = target || within source target || within target source then
        fail "account_same" "the sessions roots overlap"
      else Ok ()
  | exception Unix.Unix_error _ | exception Sys_error _ ->
      fail "account_folder_refused" "the sessions root changed"

let guarded_io check_roots (io : Carry_write.io) =
  let ensure () =
    match check_roots () with
    | Ok () -> ()
    | Error _ -> raise (Unix.Unix_error (Unix.EIO, "carry", ""))
  in
  let around f =
    ensure ();
    let value = f () in
    ensure ();
    value
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
    rename = (fun from into -> around (fun () -> io.rename from into));
    rename_noreplace = (fun from into -> around (fun () -> io.rename_noreplace from into));
    link = (fun from into -> around (fun () -> io.link from into));
    close = (fun fd -> io.close fd; ensure ());
  }


let carry ?(io = default_io) ?(limits = default_limits) ~uid ~source ~target
    ~conversation () =
  sanitized
    (if not (valid_uuid conversation) then
       fail "conversation_unknown" "not a Pi session UUID"
     else if limits.max_files < 1 || limits.max_bytes < 1
             || limits.free_margin < 0 then
       fail "conversation_too_large" "the Pi session exceeds the carry limit"
     else
       with_bound ~uid source (fun source_identity ->
           with_bound ~uid target (fun target_identity ->
               let check_roots () =
                 let* () = check_bound ~uid source source_identity in
                 check_bound ~uid target target_identity
               in
               (* Account identity is checked by the coordinator, not by the
                  history roots: distinct profiles may share this directory. *)
               let shared =
                 Carry_target.same_file source_identity target_identity
               in
               let* () = if shared then Ok () else check_distinct source target in
               Carry_target.with_lock ~uid ~target conversation (fun _ ->
                   let io = guarded_io check_roots io in
                   let* () = check_roots () in
                   let* relative = locate ~uid ~source conversation in
                   let* source_size, source_hash =
                     validate ~io ~uid ~conversation ~relative
                       ~path:(join source relative) ~maximum:limits.max_bytes
                   in
                   if shared then
                     let* () = check_roots () in
                     Ok
                       {
                         files = 1;
                         copied = 0;
                         replaced = 0;
                         unchanged = 1;
                         bytes = 0;
                       }
                    else
                    let* target_matches =
                      locate_matches ~uid ~source:target conversation
                    in
                    let* () =
                      match target_matches with
                      | [] -> Ok ()
                      | [ target_relative ] when target_relative = relative -> Ok ()
                      | _ ->
                          fail "conversation_ambiguous"
                            "the target already holds this Pi session id"
                    in
                    let* () = Carry_target.check_folders ~uid ~target relative in
                    let* () = check_roots () in
                    let* _ =
                     Carry_target.clean_leftovers ~uid ~target [ relative ]
                   in
                   let* target_stats = lstat_opt (join target relative) in
                   let* () =
                     match target_stats with
                     | None -> Ok ()
                     | Some _ ->
                         let* _ =
                           validate ~io ~uid ~conversation ~relative
                             ~path:(join target relative) ~maximum:limits.max_bytes
                         in
                         Ok ()
                   in
                   let* planned =
                     Carry_write.plan io ~uid ~source ~target
                       (relative, source_size)
                   in
                   let* () = check_roots () in
                   let needed =
                     match planned with _, _, Carry_write.Same -> 0 | _ -> source_size
                   in
                   let space =
                     if needed = 0 then Ok ()
                     else
                       match io.free_bytes target with
                       | Some available
                         when available >= needed
                           && available - needed >= limits.free_margin ->
                           Ok ()
                       | Some _ -> fail "target_no_space" "not enough space for the Pi session"
                       | None -> fail "carry_failed" "target free space is unknown"
                   in
                   let* () = check_roots () in
                   let* () = space in
                   let validate_staged staged =
                     List.fold_left
                       (fun acc (_, path, _) ->
                         let* () = acc in
                         let* size, hash =
                           validate ~io ~uid ~conversation ~relative ~path
                             ~maximum:limits.max_bytes
                         in
                         if size = source_size && hash = source_hash then Ok ()
                         else
                           fail "carry_failed"
                             "the Pi session changed during the copy")
                       (Ok ()) staged
                   in
                   let* () =
                     Carry_write.write_plan ~check_roots ~validate_staged io
                       ~uid ~source ~target [ planned ]
                   in
                   let* () = check_roots () in
                   let copied, replaced, unchanged, bytes =
                     match planned with
                     | _, _, Carry_write.Copy -> (1, 0, 0, source_size)
                     | _, _, Carry_write.Replace _ -> (0, 1, 0, source_size)
                     | _, _, Carry_write.Same -> (0, 0, 1, 0)
                   in
                   Ok { files = 1; copied; replaced; unchanged; bytes }))))
