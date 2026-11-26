(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)
open Lwt.Infix
module A = Mesh_session_artifacts

let validate_call tool args =
  let keys =
    match tool with
    | "create_note" | "replace_note" -> [ "path"; "content" ]
    | "mint_share" ->
        if A.get "kind" args = `Null then [ "path"; "label" ]
        else [ "path"; "label"; "kind" ]
    | "revoke_share" -> [ "id" ]
    | _ -> A.fail ()
  in
  A.exact keys args;
  if tool = "revoke_share" then ignore (A.string "id" 256 args)
  else
    let path = A.string "path" 4096 args in
    if
      String.contains path '\\'
      || List.exists
           (fun p -> List.mem p [ ""; "."; ".." ])
           (String.split_on_char '/' path)
    then A.fail ();
    if tool = "mint_share" then (
      ignore (A.string "label" 512 args);
      if
        not
          (List.mem (A.get "kind" args)
             [ `Null; `String "note"; `String "folder" ])
      then A.fail ())
    else
      match A.get "content" args with
      | `String s when String.length s <= 512 * 1024 -> ()
      | _ -> A.fail ()

let configuration () =
  let url = Sys.getenv "MESH_NOTES_MCP_URL" in
  let uri = A.safe_url (A.text 8192 (`String url)) in
  if Uri.fragment uri <> None || Uri.query uri <> [] then A.fail ();
  let path = Sys.getenv "MESH_NOTES_TOKEN_FILE" in
  if Filename.is_relative path || Unix.realpath path <> path then A.fail ();
  let fd = A.open_private path [ Unix.O_RDONLY; Unix.O_CLOEXEC ] in
  let ch = Unix.in_channel_of_descr fd in
  let token =
    Fun.protect
      ~finally:(fun () -> close_in_noerr ch)
      (fun () ->
        let n = in_channel_length ch in
        if n > 8192 then A.fail ();
        really_input_string ch n |> String.trim |> fun s ->
        A.text 8192 (`String s))
  in
  (uri, token)

let response_limit = 1024 * 1024

let bounded_body body =
  let stream = Cohttp_lwt.Body.to_stream body and buffer = Buffer.create 1024 in
  let rec loop () =
    Lwt_stream.get stream >>= function
    | None -> Lwt.return (Buffer.contents buffer)
    | Some chunk ->
        if Buffer.length buffer + String.length chunk > response_limit then
          Lwt.fail A.Invalid
        else (
          Buffer.add_string buffer chunk;
          loop ())
  in
  loop ()

let streamed_response id body =
  let stream = Cohttp_lwt.Body.to_stream body in
  let line = Buffer.create 256 and data = Buffer.create 1024 in
  let first = ref true and after_cr = ref false in
  let event () =
    if Buffer.length data = 0 then None
    else
      let text = Buffer.contents data |> String.trim in
      Buffer.clear data;
      if text = "" then None
      else
        let json = Yojson.Safe.from_string text in
        ignore (A.fields json);
        if A.get "method" json = `Null && A.get "id" json = `Int id then
          Some json
        else None
  in
  let finish_line () =
    let value = Buffer.contents line in
    Buffer.clear line;
    let value =
      if !first && String.starts_with ~prefix:"\239\187\191" value then
        String.sub value 3 (String.length value - 3)
      else value
    in
    first := false;
    if value = "" then event ()
    else (
      if value = "data" then Buffer.add_char data '\n'
      else if String.starts_with ~prefix:"data:" value then (
        let start = if String.starts_with ~prefix:"data: " value then 6 else 5 in
        Buffer.add_substring data value start (String.length value - start);
        Buffer.add_char data '\n');
      None)
  in
  let rec read remaining =
    Lwt_stream.get stream >>= function
    | None -> Lwt.fail A.Invalid
    | Some chunk -> scan remaining chunk 0
  and scan remaining chunk index =
    if index = String.length chunk then read remaining
    else if remaining = 0 then Lwt.fail A.Invalid
    else
      let ch = chunk.[index] and previous_cr = !after_cr in
      after_cr := ch = '\r';
      let response =
        match ch with
        | '\n' when previous_cr -> None
        | '\r' | '\n' -> finish_line ()
        | _ ->
            Buffer.add_char line ch;
            None
      in
      match response with
      | Some json -> Lwt.return json
      | None -> scan (remaining - 1) chunk (index + 1)
  in
  read response_limit

let payload result =
  match A.get "structuredContent" result with
  | `Assoc _ as v ->
      ignore (A.fields v);
      v
  | `Null -> (
      match A.get "content" result with
      | `List [ `Assoc xs ]
        when List.assoc_opt "type" xs = Some (`String "text") -> (
          match List.assoc_opt "text" xs with
          | Some (`String s) ->
              let v = Yojson.Safe.from_string s in
              ignore (A.fields v);
              v
          | _ -> A.fail ())
      | _ -> A.fail ())
  | _ -> A.fail ()

let write_outcome tool result =
  if tool <> "create_note" && tool <> "replace_note" then `String "success"
  else
    let p = payload result in
    match A.get "status" p with
    | `String "ok" ->
        A.exact [ "status" ] p;
        `String "success"
    | `String "error" ->
        A.exact [ "status"; "reason"; "message" ] p;
        ignore (A.string "reason" 80 p);
        ignore (A.string "message" (1024 * 1024) p);
        `String "upstream-error"
    | _ -> A.fail ()

let call tool args =
  validate_call tool args;
  let uri, token = configuration () in
  let session_id = ref None and sent_mutation = ref false in
  let request ?(notification = false) id meth params =
    let headers =
      Cohttp.Header.of_list
        ([
           ("authorization", "Bearer " ^ token);
           ("content-type", "application/json");
           ("accept", "application/json, text/event-stream");
           ("MCP-Protocol-Version", "2025-11-25");
         ]
        @
        match !session_id with
        | None -> []
        | Some s -> [ ("Mcp-Session-Id", s) ])
    in
    let body =
      `Assoc
        ([
           ("jsonrpc", `String "2.0");
           ("method", `String meth);
           ("params", params);
         ]
        @ if notification then [] else [ ("id", `Int id) ])
      |> Yojson.Safe.to_string |> Cohttp_lwt.Body.of_string
    in
    Cohttp_lwt_unix.Client.call ~headers ~body `POST uri
    >>= fun (response, body) ->
    let code = Cohttp.Response.status response |> Cohttp.Code.code_of_status in
    if code < 200 || code >= 300 then Lwt.fail A.Invalid
    else (
      (match
         Cohttp.Header.get (Cohttp.Response.headers response) "mcp-session-id"
       with
      | Some value -> session_id := Some (A.text 256 (`String value))
      | None -> ());
      if notification then
        bounded_body body >>= fun text ->
        if code = 202 && text = "" then Lwt.return `Null else Lwt.fail A.Invalid
      else
        let media_type =
          Cohttp.Header.get (Cohttp.Response.headers response) "content-type"
          |> Option.value ~default:"" |> fun value ->
          String.split_on_char ';' value |> List.hd |> String.trim
          |> String.lowercase_ascii
        in
        (match media_type with
        | "application/json" -> bounded_body body >|= Yojson.Safe.from_string
        | "text/event-stream" -> streamed_response id body
        | _ -> Lwt.fail A.Invalid)
        >>= fun json ->
        ignore (A.fields json);
        if
          A.get "id" json <> `Int id
          || A.get "jsonrpc" json <> `String "2.0"
          || A.get "error" json <> `Null
        then Lwt.fail A.Invalid
        else Lwt.return (A.get "result" json))
  in
  let exchange =
    request 1 "initialize"
      (`Assoc
         [
           ("protocolVersion", `String "2025-11-25");
           ("capabilities", `Assoc []);
           ( "clientInfo",
             `Assoc [ ("name", `String "mesh-notes"); ("version", `String "1") ]
           );
         ])
    >>= fun init ->
    if A.get "protocolVersion" init <> `String "2025-11-25" then
      Lwt.fail A.Invalid
    else
      request ~notification:true 0 "notifications/initialized" (`Assoc [])
      >>= fun _ ->
      sent_mutation := true;
      request 2 "tools/call"
        (`Assoc [ ("name", `String tool); ("arguments", args) ])
      >|= fun result ->
      ignore (A.fields result);
      if A.get "isError" result = `Bool true then
        `Assoc [ ("status", `String "upstream-error") ]
      else if not (List.mem (A.get "isError" result) [ `Bool false; `Null ])
      then A.fail ()
      else
        match write_outcome tool result with
        | `String "success" ->
            `Assoc [ ("status", `String "success"); ("result", result) ]
        | _ -> `Assoc [ ("status", `String "upstream-error") ]
  in
  let deadline = Lwt_unix.sleep 25. >>= fun () -> Lwt.fail A.Invalid in
  let result =
    try Lwt_main.run (Lwt.pick [ exchange; deadline ])
    with _ ->
      `Assoc
        [
          ( "status",
            `String (if !sent_mutation then "uncertain" else "unavailable") );
        ]
  in
  (uri, result)

let observation uri tool args result =
  let p = payload result in
  if tool = "mint_share" then (
    let id = A.string "id" 256 p and url = A.string "share_url" 8192 p in
    let link = A.safe_url url in
    if
      Uri.scheme link <> Uri.scheme uri
      || Uri.host link <> Uri.host uri
      || Uri.port link <> Uri.port uri
    then A.fail ();
    let present =
      match A.get "target_present" p with `Bool b -> b | _ -> A.fail ()
    in
    let kind = A.string "scope_kind" 80 p in
    if not (List.mem kind [ "note"; "folder" ]) then A.fail ();
    let requested_kind =
      match A.get "kind" args with `String k -> k | _ -> "note"
    in
    if kind <> requested_kind || A.get "scope_path" p <> A.get "path" args then
      A.fail ();
    let now = `Float (Unix.gettimeofday ()) in
    `Assoc
      [
        ("action", `String "observe");
        ( "reference",
          `Assoc
            [
              ("connector", `String "notes");
              ("id", `String id);
              ("kind", `String kind);
              ("title", `String (A.string "label" 512 args));
              ("url", `String url);
              ( "availability",
                `String
                  (if present then "observed-present" else "pending-target") );
              ("created_at", now);
              ("updated_at", now);
            ] );
      ])
  else if tool = "revoke_share" then (
    if A.get "revoked" p <> `Bool true then A.fail ();
    `Assoc [ ("action", `String "revoke"); ("id", A.get "id" args) ])
  else `Null

let execute tool args =
  match
    try
      validate_call tool args;
      true
    with _ -> false
  with
  | false -> `Assoc [ ("status", `String "invalid") ]
  | true -> (
      try
        let uri, outcome = call tool args in
        if A.get "status" outcome <> `String "success" then outcome
        else
          try
            let observed = observation uri tool args (A.get "result" outcome) in
            `Assoc (("observation", observed) :: A.fields outcome)
          with _ -> `Assoc [ ("status", `String "uncertain") ]
      with _ -> `Assoc [ ("status", `String "unavailable") ])
