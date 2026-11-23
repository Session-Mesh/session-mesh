(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

type context = {
  home : string;
  config : string;
  data : string;
  state : string;
  cache : string;
  runtime : string;
  location : string;
}

type verb = [ `Get | `Post ]
type request =
  context ->
  verb ->
  string ->
  string option ->
  (int * Yojson.Safe.t, string) result

type report = { messages : int }
type lineage = {
  logical_id : string;
  epoch : int;
  source_profile : string;
  target_profile : string;
  parent_native_id : string;
  native_id : string;
  boundary_message_id : string;
  messages : int;
}

let ( let* ) = Result.bind
let member key = function
  | `Assoc fields -> List.assoc_opt key fields
  | _ -> None

let required key value =
  match member key value with Some result -> Ok result | None -> Error "transfer_schema"

let eq key expected value = member key value = Some (`String expected)
let list = function `List rows -> Some rows | _ -> None
let max_bytes = 8 * 1024 * 1024
let max_messages = 4096

(* Official v2.3.2 packages/core/src/plugin/fork-notice.ts. Fork writes this
   synthetic inbox item; import drops it, so only this exact value may be
   restored to the target. A changed native notice needs a new proof. *)
let native_fork_notice = {|<fork-notice>
This conversation is a fork of another conversation, copied up to the previous message. The original conversation keeps going on its own and may be active right now, as may other forks of it.
- Work started before the fork belongs to the original: background subagents, background shells, schedules, and follow-ups promised there. Their results and notifications go to the original, never here, and you can't continue those subagents. Don't wait for them, redo them, or report their results as yours; if it matters, check what already happened (files, git, PRs, CI).
- Files, repositories, branches and external services are shared with the original. Before changing something the original was working on (its uncommitted changes, branches, worktrees, PRs, deploys, messages), check its current state, and put work that diverges from it on a new branch or worktree.
- Otherwise work normally: new tasks need no extra checks, branches or questions.
- If it's unclear whether this fork or the original should do something, ask.
</fork-notice>|}

let id_valid id =
  String.length id >= 8 && String.length id <= 96
  && String.starts_with ~prefix:"ses" id
  && String.for_all
       (function 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '_' | '-' -> true | _ -> false)
       id

let get request context route =
  match request context `Get route None with
  | Ok (200, response) -> required "data" response
  | _ -> Error "transfer_unavailable"

let version request context =
  match request context `Get "/api/info" None with
  | Ok (200, response) when eq "version" "2.3.2" response -> Ok ()
  | _ -> Error "transfer_unsupported_version"

let empty_list ?(nonempty = "transfer_pending") request context route =
  let* value = get request context route in
  match list value with
  | Some [] -> Ok ()
  | Some _ -> Error nonempty
  | None -> Error "transfer_schema"

let inactive request context id =
  let* active = get request context "/api/session/active" in
  match active with
  | `Assoc fields ->
      if List.mem_assoc id fields then Error "transfer_busy" else Ok ()
  | _ -> Error "transfer_schema"

let preflight ?notice request context id =
  let* () = inactive request context id in
  let base = "/api/session/" ^ id in
  let* () =
    match notice with
    | None -> empty_list request context (base ^ "/inbox")
    | Some expected ->
        let* inbox = get request context (base ^ "/inbox") in
        if inbox = `List [ expected ] then Ok ()
        else Error "transfer_pending"
  in
  let* () = empty_list request context (base ^ "/permission") in
  let* () = empty_list request context (base ^ "/form") in
  empty_list ~nonempty:"transfer_unsupported_state" request context
    ("/api/experimental/session/" ^ id ^ "/instructions/entries")

let complete_message message =
  let is value = eq "type" value message in
  if is "user" then
    List.for_all
      (fun key ->
        match member key message with
        | None | Some (`List []) -> true
        | _ -> false)
      [ "files"; "agents"; "skills" ]
  else if is "shell" then
    List.exists (fun status -> eq "status" status message)
      [ "exited"; "timeout"; "killed" ]
  else if is "agent-switched" || is "model-switched"
           || is "system" || is "skill"
  then true
  else if is "synthetic" then
    eq "description" "Fork notice" message
    && eq "text" native_fork_notice message
  else if is "idle" then eq "outcome" "succeeded" message
  else if is "assistant" then
    Option.is_some (member "finish" message)
    && (match member "time" message with
       | Some time -> Option.is_some (member "completed" time)
       | None -> false)
    && member "error" message = None
    && member "retry" message = None
    && member "snapshot" message = None
    && (match member "content" message with
       | Some (`List parts) ->
           List.for_all
             (fun part ->
               if eq "type" "tool" part then
                 match member "state" part with
                 | Some state ->
                     eq "status" "completed" state
                     && (match member "name" part with
                        | Some (`String ("subagent" | "task" | "agent")) -> false
                        | Some (`String _) -> true
                        | _ -> false)
                 | None -> false
               else
                 eq "type" "text" part || eq "type" "reasoning" part)
             parts
       | _ -> false)
  else is "compaction" && eq "status" "completed" message

let settled_time time =
  let number = function
    | `Int value -> Some (float_of_int value)
    | `Float value -> Some value
    | _ -> None
  in
  match member "busy" time with
  | None -> true
  | Some busy ->
      (match (number busy, Option.bind (member "idle" time) number) with
      | Some busy, Some idle -> idle >= busy
      | _ -> false)

let snapshot ?fork ~context ~session_id response =
  let* data = required "data" response in
  let* info = required "info" data in
  let* _ = required "projectID" info in
  let* _ = required "cost" info in
  let* _ = required "tokens" info in
  let* _ = required "time" info in
  let* raw = required "messages" data in
  let* messages =
    match list raw with
    | Some messages when List.length messages <= max_messages -> Ok messages
    | _ -> Error "transfer_unsupported_state"
  in
  let ids =
    List.filter_map
      (fun message ->
        match member "id" message with
        | Some (`String id) when String.starts_with ~prefix:"msg_" id ->
            Some id
        | _ -> None)
      messages
  in
  let* () =
    if
      List.length ids = List.length messages
      && List.length (List.sort_uniq String.compare ids) = List.length ids
      && List.for_all
           (fun message -> Option.is_some (member "time" message))
           messages
    then Ok ()
    else Error "transfer_schema"
  in
  let* location = required "location" info in
  let fork_valid =
    match (fork, member "fork" info) with
    | None, None -> true
    | Some (parent, boundary), Some value ->
        eq "sessionID" parent value
        && (match member "boundary" value with
           | Some boundary_info ->
               eq "type" "through" boundary_info
               && eq "messageID" boundary boundary_info
           | None -> false)
    | _ -> false
  in
  if
    not (eq "id" session_id info)
    || not (eq "directory" context.location location)
    || Option.is_some (member "parentID" info)
    || not fork_valid
    || Option.is_some (member "revert" info)
    || (match member "time" info with
       | Some time -> not (settled_time time)
       | None -> true)
    || not (List.for_all complete_message messages)
    || (match List.rev messages with
       | [] -> false
       | last :: _ -> not (eq "type" "idle" last))
  then Error "transfer_unsupported_state"
  else
    let bytes = Yojson.Safe.to_string data in
    if String.length bytes > max_bytes then Error "transfer_too_large"
    else Ok (info, raw, bytes)

let normalized_info info =
  match info with
  | `Assoc fields ->
      `Assoc
        (List.map
           (fun (key, value) ->
             if key = "time" then
               ( key,
                 match value with
                 | `Assoc times ->
                     `Assoc (List.remove_assoc "updated" times)
                 | _ -> value )
             else (key, value))
           (List.remove_assoc "projectID"
              (List.remove_assoc "location" fields)))
  | _ -> info

(* Native 2.3.2 import clamps the viewed watermark to idle; all other
   meaningful fields, including the exact idle timestamp, stay unchanged. *)
let imported_info info =
  match (info, member "time" info) with
  | `Assoc fields, Some (`Assoc times) ->
      let* viewed =
        match List.assoc_opt "viewed" times with
        | None -> Ok None
        | Some (`Int viewed) ->
            (match List.assoc_opt "idle" times with
            | Some (`Int idle) -> Ok (Some (min viewed idle))
            | _ -> Error "transfer_unsupported_state")
        | _ -> Error "transfer_unsupported_state"
      in
      let time =
        match viewed with
        | None -> times
        | Some viewed ->
            List.map
              (fun (key, value) ->
                (key, if key = "viewed" then `Int viewed else value))
              times
      in
      Ok
        (normalized_info
           (`Assoc
             (List.map
                (fun (key, value) ->
                  (key, if key = "time" then `Assoc time else value))
                fields)))
  | _ -> Error "transfer_schema"

let import_body info messages location =
  Yojson.Safe.to_string
    (`Assoc
      [
        ("info", info);
        ("messages", messages);
        ("location", `Assoc [ ("directory", `String location) ]);
      ])

let context_matches messages context =
  match (list messages, list context) with
  | Some all, Some current ->
      let rec after_last_compaction = function
        | [] -> None
        | message :: rest ->
            if eq "type" "compaction" message then
              (match after_last_compaction rest with
              | Some later -> Some later
              | None -> Some (message :: rest))
            else after_last_compaction rest
      in
      (match after_last_compaction all with
      | None -> current = all
      | Some suffix ->
          current = suffix
          || (match suffix with _ :: after -> current = after | [] -> false))
  | _ -> false

let fork_messages_match parent child =
  let* originals, copies =
    match (list parent, list child) with
    | Some originals, Some copies
      when List.length originals = List.length copies ->
        Ok (originals, copies)
    | _ -> Error "transfer_uncertain"
  in
  let id row =
    match member "id" row with
    | Some (`String id) -> Ok id
    | _ -> Error "transfer_uncertain"
  in
  (* v2.3.2 projectFork uses one fork-event prefix and appends each source
     row's SQLite seq. Export reads copied rows in ascending seq order; gaps
     are possible, so do not infer seq from the transcript position. *)
  let fork_id id =
    match String.rindex_opt id '_' with
    | None -> Error "transfer_uncertain"
    | Some separator ->
        let prefix = String.sub id 0 separator in
        let digits =
          String.sub id (separator + 1) (String.length id - separator - 1)
        in
        if
          String.length prefix <= 4
          || not (String.starts_with ~prefix:"msg_" prefix)
          || String.length digits = 0
          || digits.[0] = '0'
          || not
               (String.for_all (fun ch -> ch >= '0' && ch <= '9') digits)
        then Error "transfer_uncertain"
        else Ok (prefix, digits)
  in
  let* () =
    let rec ordered previous = function
      | [] -> Ok ()
      | copy :: rest ->
          let* copy_id = id copy in
          let* prefix, digits = fork_id copy_id in
          let increasing =
            match previous with
            | None -> true
            | Some (prior_prefix, prior_digits) ->
                prefix = prior_prefix
                && (String.length digits > String.length prior_digits
                   || (String.length digits = String.length prior_digits
                      && String.compare digits prior_digits > 0))
          in
          if increasing then ordered (Some (prefix, digits)) rest
          else Error "transfer_uncertain"
    in
    ordered None copies
  in
  let* positions =
    List.fold_left2
      (fun acc original copy ->
        let* acc = acc in
        let* parent_id = id original in
        let* child_id = id copy in
        Ok ((parent_id, child_id) :: acc))
      (Ok []) originals copies
  in
  let* equal =
    List.fold_left2
      (fun acc original copy ->
        let* equal = acc in
        if not equal then Ok false
        else
          let* child_id = id copy in
          match original with
          | `Assoc fields ->
              let* fields =
                if not (eq "type" "compaction" original) then Ok fields
                else
                  match member "metadata" original with
                  | None -> Ok fields
                  | Some (`Assoc metadata) ->
                      (match List.filter
                               (fun (key, _) -> key = "keepID")
                               metadata
                       with
                      | [] -> Ok fields
                      | [ (_, `String reference) ] ->
                          (match List.assoc_opt reference positions with
                          | None -> Error "transfer_uncertain"
                          | Some mapped ->
                              let updated =
                                `Assoc
                                  (List.map
                                     (fun (key, value) ->
                                       ( key,
                                         if key = "keepID" then `String mapped
                                         else value ))
                                     metadata)
                              in
                              Ok
                                (List.map
                                   (fun (key, value) ->
                                     ( key,
                                       if key = "metadata" then updated
                                       else value ))
                                   fields))
                      | _ -> Error "transfer_uncertain")
                  | _ -> Error "transfer_uncertain"
              in
              Ok
                (`Assoc
                   (List.map
                      (fun (key, value) ->
                        (key, if key = "id" then `String child_id else value))
                      fields)
                = copy)
          | _ -> Error "transfer_uncertain")
      (Ok true) originals copies
  in
  if equal then Ok () else Error "transfer_uncertain"

let transfer_with_fork ?notice ?expected_messages fork ~request ~source ~target ~session_id =
  if not (id_valid session_id) || source = target
     || source.location <> target.location
  then Error "transfer_invalid_input"
  else
    let* () = version request source in
    let* () = version request target in
    let* () = inactive request source session_id in
    let* source_response =
      match
        request source `Get
          ("/api/experimental/session/" ^ session_id ^ "/export")
          None
      with
      | Ok (200, response) -> Ok response
      | _ -> Error "transfer_unavailable"
    in
    let* source_info, messages, original =
      snapshot ?fork ~context:source ~session_id source_response
    in
    let* expected_info = imported_info source_info in
    let* () =
      match expected_messages with
      | None -> Ok ()
      | Some expected when messages = expected -> Ok ()
      | Some _ -> Error "transfer_uncertain"
    in
    let* () = preflight ?notice request source session_id in
    let* source_context =
      get request source ("/api/session/" ^ session_id ^ "/context")
    in
    let* () =
      if context_matches messages source_context then Ok ()
      else Error "transfer_unsupported_state"
    in
    let* () = inactive request target session_id in
    let* () =
      match
        request target `Get
          ("/api/experimental/session/" ^ session_id ^ "/export")
          None
      with
      | Ok (404, _) -> Ok ()
      | Ok (200, _) -> Error "transfer_diverged"
      | _ -> Error "transfer_unavailable"
    in
    let body = import_body source_info messages target.location in
    if String.length body > max_bytes then Error "transfer_too_large"
    else
      (* No request after this point is allowed to import again. Every missing,
         malformed or failing acknowledgement is uncertain, including 409:
         the target may already have committed. *)
      match
        request target `Post "/api/experimental/session/import" (Some body)
      with
      | Ok (200, ack) -> (
          match required "data" ack with
          | Ok info when eq "id" session_id info ->
              let* target_response =
                match
                  request target `Get
                    ("/api/experimental/session/" ^ session_id ^ "/export")
                    None
                with
                | Ok (200, response) -> Ok response
                | _ -> Error "transfer_uncertain"
              in
              let* target_info, target_messages, _ =
                Result.map_error (fun _ -> "transfer_uncertain")
                  (snapshot ~context:target ~session_id target_response)
              in
              if
                target_messages <> messages
                  || normalized_info target_info
                     <> (match (fork, expected_info) with
                        | Some _, `Assoc fields ->
                            `Assoc (List.remove_assoc "fork" fields)
                        | _ -> expected_info)
              then Error "transfer_uncertain"
              else
                let* target_context =
                  Result.map_error (fun _ -> "transfer_uncertain")
                    (get request target
                       ("/api/session/" ^ session_id ^ "/context"))
                in
                let* () =
                  Result.map_error (fun _ -> "transfer_uncertain")
                    (preflight request target session_id)
                in
                let* () =
                  if target_context = source_context then Ok ()
                  else Error "transfer_uncertain"
                in
                let* source_again =
                  match
                    request source `Get
                      ("/api/experimental/session/" ^ session_id ^ "/export")
                      None
                  with
                  | Ok (200, response) -> Ok response
                  | _ -> Error "transfer_uncertain"
                in
                let* _, _, current =
                  Result.map_error (fun _ -> "transfer_uncertain")
                     (snapshot ?fork ~context:source ~session_id source_again)
                in
                if current <> original then Error "transfer_uncertain"
                else
                  (match list messages with
                  | Some rows -> Ok { messages = List.length rows }
                  | None -> Error "transfer_uncertain")
          | _ -> Error "transfer_uncertain")
      | _ -> Error "transfer_uncertain"

let transfer ~request ~source ~target ~session_id =
  transfer_with_fork None ~request ~source ~target ~session_id

(* Native 2.3.2 transport. Only the child of this invocation is stopped; no
   shared service or model process is used. Curl reads the transcript from a
   0600 private file, not from an argv value. A common runner HOME is not OS
   isolation; the caller must fence actual profile roots and active sessions. *)
let clock () = Mtime.Span.to_float_ns (Mtime_clock.elapsed ()) /. 1e9

let private_directory path =
  match Unix.lstat path with
  | st ->
      st.Unix.st_kind = Unix.S_DIR
      && st.Unix.st_uid = Unix.geteuid ()
      && st.Unix.st_perm land 0o077 = 0
      && Mesh_accounts.valid_path path
      && Result.is_ok
           (Mesh_accounts.check_directory ~uid:(Unix.geteuid ()) path)
  | exception Unix.Unix_error _ -> false

let receipt_id_valid value =
  String.length value >= 1 && String.length value <= 96
  && String.for_all
       (function 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' | '_' | '-' -> true | _ -> false)
       value

let receipt_path directory operation_id phase =
  Filename.concat directory
    (".opencode-lineage-" ^ operation_id ^ "-" ^ phase)

let receipt_taken directory operation_id =
  match Unix.lstat (receipt_path directory operation_id "prepared") with
  | _ -> true
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> false
  | exception Unix.Unix_error _ -> true

(* A create-only, fsynced phase file. Even a truncated phase file prevents
   repetition of the operation ID; no cleanup or retry can silently re-fork. *)
let append_receipt ~directory ~operation_id ~phase value =
  try
    let path = receipt_path directory operation_id phase in
    let bytes = Yojson.Safe.to_string value ^ "\n" in
    if String.length bytes > 4096 || not (private_directory directory) then
      Error "transfer_invalid_input"
    else
      let folder =
        Unix.openfile directory [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0
      in
      Fun.protect ~finally:(fun () -> Unix.close folder) (fun () ->
          let original = Unix.fstat folder in
          let file =
            Unix.openfile path
              [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
              0o600
          in
          Fun.protect ~finally:(fun () -> Unix.close file) (fun () ->
              Unix.fchmod file 0o600;
              let rec write offset =
                if offset < String.length bytes then
                  let count =
                    Unix.write_substring file bytes offset
                      (String.length bytes - offset)
                  in
                  if count = 0 then raise End_of_file
                  else write (offset + count)
              in
              write 0;
              Unix.fsync file;
              let current = Unix.lstat path in
              let opened = Unix.fstat file in
              if
                not
                  (current.Unix.st_kind = Unix.S_REG
                  && current.Unix.st_uid = Unix.geteuid ()
                  && current.Unix.st_perm land 0o777 = 0o600
                  && current.Unix.st_nlink = 1
                  && current.Unix.st_dev = opened.Unix.st_dev
                  && current.Unix.st_ino = opened.Unix.st_ino
                  && original.Unix.st_dev = (Unix.lstat directory).Unix.st_dev
                  && original.Unix.st_ino = (Unix.lstat directory).Unix.st_ino)
              then Error "transfer_uncertain"
              else (
                Unix.fsync folder;
                Ok ())))
  with Unix.Unix_error _ | Sys_error _ | End_of_file ->
    Error "transfer_uncertain"

let fork_transfer ~request ~source ~target ~parent_native_id ~logical_id
    ~epoch ~source_profile ~target_profile ~receipt_directory ~operation_id =
  if
    not (id_valid parent_native_id)
    || not (receipt_id_valid logical_id && receipt_id_valid operation_id)
    || not (receipt_id_valid source_profile && receipt_id_valid target_profile)
    || source_profile = target_profile || epoch < 1
    || not (private_directory receipt_directory)
    || source = target
    || source.location <> target.location
  then Error "transfer_invalid_input"
  else if receipt_taken receipt_directory operation_id then
    Error "transfer_uncertain"
  else
    let* () = version request source in
    let* () = version request target in
    let* () = preflight request source parent_native_id in
    let* parent_response =
      match
        request source `Get
          ("/api/experimental/session/" ^ parent_native_id ^ "/export")
          None
      with
      | Ok (200, response) -> Ok response
      | _ -> Error "transfer_unavailable"
    in
    let* _, parent_messages, _ =
      snapshot ~context:source ~session_id:parent_native_id parent_response
    in
    let* parent_context =
      get request source ("/api/session/" ^ parent_native_id ^ "/context")
    in
    let* () =
      if context_matches parent_messages parent_context then Ok ()
      else Error "transfer_unsupported_state"
    in
    let* boundary =
      match list parent_messages with
      | Some messages ->
          (match List.rev messages with
          | last :: _ ->
              (match member "id" last with
              | Some (`String id) -> Ok id
              | _ -> Error "transfer_schema")
          | [] -> Error "transfer_unsupported_state")
      | None -> Error "transfer_schema"
    in
    let prepared =
      `Assoc
        [
          ("version", `Int 1);
          ("logical_id", `String logical_id);
          ("epoch", `Int epoch);
          ("source_profile", `String source_profile);
          ("target_profile", `String target_profile);
          ("parent_native_id", `String parent_native_id);
          ("boundary_message_id", `String boundary);
        ]
    in
    let* () =
      append_receipt ~directory:receipt_directory ~operation_id
        ~phase:"prepared" prepared
    in
    let append_after_fork phase value =
      Result.map_error (fun _ -> "transfer_uncertain")
        (append_receipt ~directory:receipt_directory ~operation_id ~phase value)
    in
    (* A missing fork acknowledgement is uncertain. Never retry this POST:
       the source may already have created an otherwise unknown native ID. *)
    let* forked =
      match
        request source `Post
          ("/api/session/" ^ parent_native_id ^ "/fork")
          (Some "{}")
      with
      | Ok (200, response) ->
          Result.map_error (fun _ -> "transfer_uncertain")
            (required "data" response)
      | _ -> Error "transfer_uncertain"
    in
    let* native_id =
      match member "id" forked with
      | Some (`String value)
        when id_valid value && value <> parent_native_id ->
          Ok value
      | _ -> Error "transfer_uncertain"
    in
    let* () =
      if
        member "parentID" forked = None
        && (match member "fork" forked with
           | Some value ->
               eq "sessionID" parent_native_id value
               && (match member "boundary" value with
                  | Some fork_boundary ->
                      eq "type" "through" fork_boundary
                      && eq "messageID" boundary fork_boundary
                  | None -> false)
           | None -> false)
      then Ok ()
      else Error "transfer_uncertain"
    in
    let forked_record =
      match prepared with
      | `Assoc fields -> `Assoc (("native_id", `String native_id) :: fields)
      | _ -> prepared
    in
    let* () =
      append_after_fork "forked" forked_record
    in
    let* child_response =
      match
        request source `Get
          ("/api/experimental/session/" ^ native_id ^ "/export")
          None
      with
      | Ok (200, response) -> Ok response
      | _ -> Error "transfer_uncertain"
    in
    let* _, child_messages, _ =
      Result.map_error (fun _ -> "transfer_uncertain")
        (snapshot ~fork:(parent_native_id, boundary) ~context:source
           ~session_id:native_id child_response)
    in
    let* () =
      fork_messages_match parent_messages child_messages
    in
    let* notice =
      match
        get request source ("/api/session/" ^ native_id ^ "/inbox")
      with
      | Ok (`List [ notice ]) ->
          (match member "payload" notice with
          | Some payload ->
              (match member "text" payload with
              | Some (`String text)
                when text = native_fork_notice
                     && eq "id" ("msg_fork_notice_" ^ native_id) notice
                     && eq "sessionID" native_id notice
                     && eq "type" "synthetic" notice
                     && eq "delivery" "steer" notice
                     && eq "description" "Fork notice" payload
                     && String.length text <= 4096 ->
                  Ok notice
              | _ -> Error "transfer_uncertain")
          | None -> Error "transfer_uncertain")
      | _ -> Error "transfer_uncertain"
    in
    let* () =
      append_after_fork "validated"
        (`Assoc
          [
            ("lineage", forked_record);
            ("pending_native_notice", notice);
          ])
    in
    let* report =
      match
        transfer_with_fork ~notice ~expected_messages:child_messages
          (Some (parent_native_id, boundary)) ~request
          ~source ~target ~session_id:native_id
      with
      | Ok report -> Ok report
      | Error reason ->
          ignore
            (append_receipt ~directory:receipt_directory ~operation_id
               ~phase:"refused"
               (`Assoc [ ("code", `String reason); ("native_id", `String native_id) ]));
          Error "transfer_uncertain"
    in
    let payload = member "payload" notice in
    let* notice_body =
      match payload with
      | Some (`Assoc fields) ->
          Ok
            (Yojson.Safe.to_string
               (`Assoc
                 (("id", `String ("msg_fork_notice_" ^ native_id))
                 :: ("delivery", `String "steer")
                 :: ("resume", `Bool false)
                 :: fields)))
      | _ -> Error "transfer_uncertain"
    in
    let* () =
      match
        request target `Post ("/api/session/" ^ native_id ^ "/synthetic")
          (Some notice_body)
      with
      | Ok (200, _) -> Ok ()
      | _ -> Error "transfer_uncertain"
    in
    let* target_notice =
      Result.map_error (fun _ -> "transfer_uncertain")
        (get request target ("/api/session/" ^ native_id ^ "/inbox"))
    in
    let* () =
      match target_notice with
      | `List [ restored ]
        when member "id" restored = member "id" notice
             && member "payload" restored = payload
             && eq "delivery" "steer" restored ->
          Ok ()
      | _ -> Error "transfer_uncertain"
    in
    let result =
      {
        logical_id;
        epoch;
        source_profile;
        target_profile;
        parent_native_id;
        native_id;
        boundary_message_id = boundary;
        messages = report.messages;
      }
    in
    let* () =
      append_after_fork "imported" forked_record
    in
    Ok result

let context_valid context =
  List.for_all private_directory
    [
      context.home;
      context.config;
      context.data;
      context.state;
      context.cache;
      context.runtime;
    ]
  && Mesh_accounts.valid_path context.location
  && (match Unix.lstat context.location with
     | st ->
         st.Unix.st_kind = Unix.S_DIR && st.Unix.st_uid = Unix.geteuid ()
     | exception Unix.Unix_error _ -> false)

let overlaps a b =
  a = b || String.starts_with ~prefix:(a ^ "/") b
  || String.starts_with ~prefix:(b ^ "/") a

let disjoint source target =
  let profile_roots context =
    [
      context.config;
      context.data;
      context.state;
      context.cache;
    ]
  in
  let source_roots = profile_roots source
  and target_roots = profile_roots target in
  let separate a b =
    if overlaps a b then false
    else
      let left = Unix.lstat a and right = Unix.lstat b in
      left.Unix.st_dev <> right.Unix.st_dev
      || left.Unix.st_ino <> right.Unix.st_ino
  in
  (* HOME is the runner's common HOME, not a profile root. Runtime directories
     are private to this operation and must not write inside either profile. *)
  List.for_all
    (fun a -> List.for_all (separate a) target_roots)
    source_roots
  && separate source.runtime target.runtime
  && List.for_all
       (fun root -> separate source.runtime root && separate target.runtime root)
       (source_roots @ target_roots)

let environment context password =
  Array.of_list
    ([
       "HOME=" ^ context.home;
       "XDG_CONFIG_HOME=" ^ context.config;
       "XDG_DATA_HOME=" ^ context.data;
       "XDG_STATE_HOME=" ^ context.state;
       "XDG_CACHE_HOME=" ^ context.cache;
       "XDG_RUNTIME_DIR=" ^ context.runtime;
       "PATH=/usr/bin:/bin";
     ]
    @
    (if password = "" then []
     else [ "OPENCODE_SERVER_PASSWORD=" ^ password ]))

let random_password () =
  let fd = Unix.openfile "/dev/urandom" [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let bytes = Bytes.create 32 in
      let rec read offset =
        if offset < Bytes.length bytes then
          let count = Unix.read fd bytes offset (Bytes.length bytes - offset) in
          if count = 0 then raise End_of_file else read (offset + count)
      in
      read 0;
      String.concat ""
        (List.init (Bytes.length bytes) (fun i ->
             Printf.sprintf "%02x" (Char.code (Bytes.get bytes i)))))

let close fd = try Unix.close fd with Unix.Unix_error _ -> ()

let reap pid =
  (try Unix.kill pid Sys.sigterm with Unix.Unix_error (Unix.ESRCH, _, _) -> ());
  let deadline = clock () +. 1. in
  let rec wait () =
    match Unix.waitpid [ Unix.WNOHANG ] pid with
    | 0, _ when clock () < deadline ->
        ignore (Unix.select [] [] [] 0.01);
        wait ()
    | 0, _ ->
        (try Unix.kill pid Sys.sigkill
         with Unix.Unix_error (Unix.ESRCH, _, _) -> ());
        ignore (Unix.waitpid [] pid)
    | _ -> ()
    | exception Unix.Unix_error (Unix.EINTR, _, _) -> wait ()
    | exception Unix.Unix_error (Unix.ECHILD, _, _) -> ()
  in
  wait ()

let read_line fd =
  let deadline = clock () +. 10. in
  let one = Bytes.create 1 and buffer = Buffer.create 64 in
  let rec loop () =
    if clock () > deadline || Buffer.length buffer > 256 then
      Error "transfer_unavailable"
    else
      match
        Unix.select [ fd ] [] []
          (Float.max 0. (Float.min 0.2 (deadline -. clock ())))
      with
      | [], _, _ -> loop ()
      | _, _, _ ->
          let count = Unix.read fd one 0 1 in
          if count = 0 then Error "transfer_unavailable"
          else if Bytes.get one 0 = '\n' then Ok (Buffer.contents buffer)
          else (
            Buffer.add_char buffer (Bytes.get one 0);
            loop ())
  in
  loop ()

let port_of_line line =
  try
    let value = Yojson.Safe.from_string line in
    match member "url" value with
    | Some (`String url) ->
        let prefix = "http://127.0.0.1:" in
        if not (String.starts_with ~prefix url) then
          Error "transfer_unavailable"
        else
          let raw =
            String.sub url (String.length prefix)
              (String.length url - String.length prefix)
          in
          if
            raw = ""
            || not
                 (String.for_all
                    (function '0' .. '9' -> true | _ -> false)
                    raw)
          then Error "transfer_unavailable"
          else
            let port = int_of_string raw in
            if port >= 1 && port <= 65535 then Ok port
            else Error "transfer_unavailable"
    | _ -> Error "transfer_unavailable"
  with Yojson.Json_error _ | Failure _ -> Error "transfer_unavailable"

let with_server binary context f =
  let input, keep_alive = Unix.pipe ~cloexec:true () in
  Fun.protect
    ~finally:(fun () -> List.iter close [ input; keep_alive ])
    (fun () ->
      let error = Unix.openfile "/dev/null" [ Unix.O_WRONLY; Unix.O_CLOEXEC ] 0 in
      Fun.protect ~finally:(fun () -> close error) (fun () ->
          let output, writer = Unix.pipe ~cloexec:true () in
          Fun.protect
            ~finally:(fun () -> List.iter close [ output; writer ])
            (fun () ->
              let password = random_password () in
              let pid =
                Unix.create_process_env "/bin/sh"
                  [|
                    "/bin/sh";
                    "-c";
                    "cd \"$HOME\" && exec \"$1\" serve --stdio --hostname 127.0.0.1 --port 0";
                    "mesh-opencode";
                    binary;
                  |]
                  (environment context password) input writer error
              in
              Fun.protect ~finally:(fun () -> reap pid) (fun () ->
                  List.iter close [ input; error; writer ];
                  let* line = read_line output in
                  let* port = port_of_line line in
                  f port password))))

let with_temp directory f =
  let path = Filename.temp_file ~temp_dir:directory "mesh-opencode-" ".tmp" in
  let original = Unix.lstat path in
  Fun.protect
    ~finally:(fun () ->
      try
        let current = Unix.lstat path in
        if
          current.Unix.st_dev = original.Unix.st_dev
          && current.Unix.st_ino = original.Unix.st_ino
        then Unix.unlink path
      with Unix.Unix_error _ -> ())
    (fun () -> f path)

let write_private path content =
  let fd = Unix.openfile path [ Unix.O_WRONLY; Unix.O_TRUNC; Unix.O_CLOEXEC ] 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      Unix.fchmod fd 0o600;
      let rec write offset =
        if offset < String.length content then
          let count =
            Unix.write_substring fd content offset (String.length content - offset)
          in
          if count = 0 then raise End_of_file else write (offset + count)
      in
      write 0)

let read_capped path =
  let fd = Unix.openfile path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let size = (Unix.fstat fd).Unix.st_size in
      if size > max_bytes + 16384 then Error "transfer_too_large"
      else
        let buffer = Buffer.create size and chunk = Bytes.create 8192 in
        let rec read () =
          let count = Unix.read fd chunk 0 (Bytes.length chunk) in
          if count = 0 then Ok (Buffer.contents buffer)
          else if Buffer.length buffer + count > max_bytes + 16384 then
            Error "transfer_too_large"
          else (
            Buffer.add_subbytes buffer chunk 0 count;
            read ())
        in
        read ())

let wait_child pid =
  let deadline = clock () +. 12. in
  let rec wait () =
    match Unix.waitpid [ Unix.WNOHANG ] pid with
    | 0, _ when clock () < deadline ->
        ignore (Unix.select [] [] [] 0.02);
        wait ()
    | 0, _ ->
        (try Unix.kill pid Sys.sigkill
         with Unix.Unix_error (Unix.ESRCH, _, _) -> ());
        ignore (Unix.waitpid [] pid);
        Error "transfer_unavailable"
    | _, Unix.WEXITED 0 -> Ok ()
    | _ -> Error "transfer_unavailable"
    | exception Unix.Unix_error (Unix.EINTR, _, _) -> wait ()
  in
  wait ()

let with_null flags f =
  let fd = Unix.openfile "/dev/null" (Unix.O_CLOEXEC :: flags) 0 in
  Fun.protect ~finally:(fun () -> close fd) (fun () -> f fd)

let http context ~port ~password verb route body =
  if String.length route > 160 || String.contains route '\n' then
    Error "transfer_invalid_input"
  else
    with_temp context.runtime (fun config ->
        with_temp context.runtime (fun output ->
            with_temp context.runtime (fun input ->
                let body = Option.value body ~default:"" in
                if String.length body > max_bytes then Error "transfer_too_large"
                else (
                  write_private config
                    ("user = \"opencode:" ^ password ^ "\"\n");
                  write_private input body;
                  let url = Printf.sprintf "http://127.0.0.1:%d%s" port route in
                  let args =
                     [
                       "/usr/bin/curl";
                       "-q";
                      "--config";
                      config;
                      "--silent";
                      "--noproxy";
                      "*";
                      "--proto";
                      "=http";
                      "--max-time";
                      "8";
                      "--max-filesize";
                      string_of_int (max_bytes + 16384);
                      "--request";
                      (if verb = `Post then "POST" else "GET");
                      "--output";
                      output;
                      "--write-out";
                      "%{http_code}";
                    ]
                    @
                    (if verb = `Post then
                       [
                         "--header";
                         "Content-Type: application/json";
                         "--data-binary";
                         "@" ^ input;
                       ]
                     else [])
                     @ [ "--"; url ]
                  in
                  with_null [ Unix.O_WRONLY ] (fun sink ->
                      with_null [ Unix.O_RDONLY ] (fun source ->
                          let status_read, status_write =
                            Unix.pipe ~cloexec:true ()
                          in
                          Fun.protect
                            ~finally:(fun () ->
                              List.iter close [ status_read; status_write ])
                            (fun () ->
                              let pid =
                                Unix.create_process_env "/usr/bin/curl"
                                  (Array.of_list args)
                                  (environment context "") source status_write
                                  sink
                              in
                              List.iter close [ sink; source; status_write ];
                              let* () = wait_child pid in
                              let status = Bytes.create 4 in
                              let count = Unix.read status_read status 0 4 in
                              if count <> 3 then Error "transfer_unavailable"
                              else
                                let code =
                                  try
                                    int_of_string (Bytes.sub_string status 0 count)
                                  with Failure _ -> 0
                                in
                                let* bytes = read_capped output in
                                if code < 100 || code > 599 then
                                  Error "transfer_unavailable"
                                else
                                  try
                                    Ok (code, Yojson.Safe.from_string bytes)
                                  with Yojson.Json_error _ ->
                                    Error "transfer_unavailable")))))))

let with_native ~binary ~source ~target operation =
  let attempted = ref false in
  try
    let executable = Unix.lstat binary in
    if
      Filename.is_relative binary
      || executable.Unix.st_kind <> Unix.S_REG
      || executable.Unix.st_uid <> Unix.geteuid ()
      || executable.Unix.st_perm land 0o111 = 0
      || not (context_valid source && context_valid target)
      || not (disjoint source target)
      || source.location <> target.location
    then Error "transfer_invalid_input"
    else
      with_server binary source (fun source_port source_password ->
          with_server binary target (fun target_port target_password ->
              let request context verb route body =
                if verb = `Post then attempted := true;
                try
                  if context == source then
                    http source ~port:source_port ~password:source_password
                      verb route body
                  else if context == target then
                    http target ~port:target_port ~password:target_password
                      verb route body
                  else Error "transfer_invalid_input"
                with
                | Out_of_memory as exn -> raise exn
                | _ -> Error "transfer_unavailable"
              in
               operation request))
  with
  | Out_of_memory as exn -> raise exn
  | _ ->
      Error
         (if !attempted then "transfer_uncertain"
          else "transfer_unavailable")

let run ~binary ~source ~target ~session_id =
  with_native ~binary ~source ~target (fun request ->
      transfer ~request ~source ~target ~session_id)

let run_fork ~binary ~source ~target ~parent_native_id ~logical_id ~epoch
    ~source_profile ~target_profile ~receipt_directory ~operation_id =
  with_native ~binary ~source ~target (fun request ->
      fork_transfer ~request ~source ~target ~parent_native_id ~logical_id
        ~epoch ~source_profile ~target_profile ~receipt_directory ~operation_id)
