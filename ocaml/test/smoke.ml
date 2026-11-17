(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let document version =
  `Assoc
    [
      ("elements", `List []);
      ("appState", `Assoc []);
      ("files", `Assoc []);
      ("version", `Int version);
    ]

let field_names fields = List.map fst fields |> List.sort String.compare

let contains_substring haystack needle =
  let rec loop offset =
    if offset + String.length needle > String.length haystack then false
    else if String.sub haystack offset (String.length needle) = needle then true
    else loop (offset + 1)
  in
  needle = "" || loop 0

let result_fields = function
  | Some response -> (
      match Yojson.Safe.from_string response with
      | `Assoc
          [
            ("jsonrpc", `String "2.0"); ("id", `Int _); ("result", `Assoc fields);
          ] ->
          fields
      | _ -> [])
  | None -> []

(* macOS interrupts waitpid with EINTR here (a signal reaches the test
   process); retry until the child is reaped. *)
let rec waitpid_retrying child =
  try Unix.waitpid [] child
  with Unix.Unix_error (Unix.EINTR, _, _) -> waitpid_retrying child

let with_http_response status body f =
  let socket = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.setsockopt socket Unix.SO_REUSEADDR true;
  Unix.bind socket (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
  Unix.listen socket 1;
  let port =
    match Unix.getsockname socket with
    | Unix.ADDR_INET (_, port) -> port
    | Unix.ADDR_UNIX _ -> failwith "expected internet socket"
  in
  match Unix.fork () with
  | 0 ->
      ignore (Sys.signal Sys.sigalrm (Sys.Signal_handle (fun _ -> exit 124)));
      ignore (Unix.alarm 5);
      let client, _ = Unix.accept socket in
      let buffer = Bytes.create 4096 in
      ignore (Unix.read client buffer 0 (Bytes.length buffer));
      let response =
        Printf.sprintf
          "HTTP/1.1 %s\r\n\
           Content-Type: application/json\r\n\
           Content-Length: %d\r\n\
           Connection: close\r\n\
           \r\n\
           %s"
          status (String.length body) body
      in
      ignore (Unix.write_substring client response 0 (String.length response));
      Unix.close client;
      Unix.close socket;
      exit 0
  | child ->
      Fun.protect
        ~finally:(fun () ->
          Unix.close socket;
          ignore (waitpid_retrying child))
        (fun () -> f port)

let initialized_session port =
  let config =
    Result.get_ok (Mesh_board_mcp.Config.make_for_test ~token:"token" ~port ())
  in
  let session = Mcp_kit.Server.create_session (Mesh_board_mcp.server config) in
  ignore
    (Mcp_kit_stdio.serve_session_line session
       {|{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"codex","version":"0.160.0"}}}|});
  ignore
    (Mcp_kit_stdio.serve_session_line session
       {|{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}|});
  session

let test_config () =
  Alcotest.(check (result unit string))
    "valid test config" (Ok ())
    (Mesh_board_mcp.Config.make_for_test ~token:"token" ~port:7690 ()
    |> Result.map (fun _ -> ()));
  Alcotest.(check (result unit string))
    "reject empty token" (Error "MESH_SESSION_TOKEN is required")
    (Mesh_board_mcp.Config.make_for_test ~token:"" ~port:7690 ()
    |> Result.map (fun _ -> ()));
  Alcotest.(check bool)
    "reject out-of-range port" true
    (Result.is_error
       (Mesh_board_mcp.Config.make_for_test ~token:"token" ~port:0 ()))

let test_document_shape () =
  Alcotest.(check (result unit string))
    "valid document" (Ok ())
    (Mesh_board_mcp.valid_document (document 0));
  Alcotest.(check bool)
    "files rejected" true
    (Result.is_error
       (Mesh_board_mcp.valid_document
          (`Assoc
             [
               ("elements", `List []);
               ("appState", `Assoc []);
               ("files", `Assoc [ ("x", `String "no") ]);
               ("version", `Int 0);
             ])))

let test_tools () =
  let config =
    Result.get_ok
      (Mesh_board_mcp.Config.make_for_test ~token:"token" ~port:7690 ())
  in
  let request =
    {|{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"codex","version":"0.160.0"}}}|}
  in
  let server = Mesh_board_mcp.server config in
  let session = Mcp_kit.Server.create_session server in
  let response = Mcp_kit_stdio.serve_session_line session request in
  Alcotest.(check bool) "server initializes" true (Option.is_some response);
  Alcotest.(check (option string))
    "echoes Codex legacy protocol version" (Some "2025-06-18")
    (match response with
    | Some response -> (
        match Yojson.Safe.from_string response with
        | `Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `Int 1);
              ("result", `Assoc fields);
            ] -> (
            match List.assoc_opt "protocolVersion" fields with
            | Some (`String version) -> Some version
            | _ -> None)
        | _ -> None)
    | None -> None);
  let initialization_fields =
    match response with
    | Some response -> (
        match Yojson.Safe.from_string response with
        | `Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `Int 1);
              ("result", `Assoc fields);
            ] ->
            fields
        | _ -> [])
    | None -> []
  in
  Alcotest.(check (list string))
    "2025-06 initialization uses the exact standard fields"
    [ "capabilities"; "instructions"; "protocolVersion"; "serverInfo" ]
    (field_names initialization_fields);
  ignore
    (Mcp_kit_stdio.serve_session_line session
       {|{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}|});
  let list =
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}|}
  in
  let list_fields =
    match list with
    | Some response -> (
        match Yojson.Safe.from_string response with
        | `Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `Int 2);
              ("result", `Assoc fields);
            ] ->
            fields
        | _ -> [])
    | None -> []
  in
  Alcotest.(check (list string))
    "2025-06 tools/list uses the exact standard fields" [ "tools" ]
    (field_names list_fields);
  let names =
    match list with
    | Some response -> (
        match Yojson.Safe.from_string response with
        | `Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `Int 2);
              ("result", `Assoc fields);
            ] -> (
            match List.assoc_opt "tools" fields with
            | Some (`List tools) ->
                List.filter_map
                  (function
                    | `Assoc fields -> (
                        match List.assoc_opt "name" fields with
                        | Some (`String name) -> Some name
                        | _ -> None)
                    | _ -> None)
                  tools
            | _ -> [])
        | _ -> [])
    | None -> []
  in
  Alcotest.(check (list string))
    "board and static demo scene tools"
    [
      "whiteboard_get";
      "whiteboard_replace";
      "whiteboard_open";
      "whiteboard_refresh";
      "whiteboard_revisions";
      "whiteboard_revision";
      "whiteboard_revision_diff";
      "whiteboard_latest_change";
      "whiteboard_restore";
      "demo_create";
      "demo_update";
      "demo_revisions";
      "demo_open";
      "demo_list";
      "demo_create_named";
      "demo_read_named";
      "demo_update_named";
      "demo_revisions_named";
      "demo_restore_named";
      "demo_open_named";
      "agent_peers";
      "agent_inbox";
      "agent_message_read";
      "agent_message_send";
      "agent_message_reply";
      "agent_message_ack";
      "session_create_request";
      "session_restart_request";
      "session_action_status";
      "agent_guide_read";
    ]
    names;
  Alcotest.(check bool)
    "agent read advertises owner approval retry protocol" true
    (match list with
    | Some response ->
        contains_substring response "owner approval is pending"
        && contains_substring response "yes, no, or always"
    | None -> false);
  let invalid_open =
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whiteboard_open","arguments":{"session":"another-session"}}}|}
  in
  let invalid_open_fields =
    match invalid_open with
    | Some response -> (
        match Yojson.Safe.from_string response with
        | `Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `Int 3);
              ("result", `Assoc fields);
            ] ->
            fields
        | _ -> [])
    | None -> []
  in
  Alcotest.(check (list string))
    "2025-06 tool result uses the exact standard fields"
    [ "content"; "isError" ]
    (field_names invalid_open_fields);
  Alcotest.(check bool)
    "open rejects target-selection input before the network" true
    (match invalid_open with
    | Some response -> (
        match Yojson.Safe.from_string response with
        | `Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `Int 3);
              ("result", `Assoc fields);
            ] ->
            List.assoc_opt "isError" fields = Some (`Bool true)
        | _ -> false)
    | None -> false);
  let invalid_demo_open =
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"demo_open","arguments":{"session":"another-session"}}}|}
  in
  Alcotest.(check bool)
    "demo open rejects target-selection input before the network" true
    (List.assoc_opt "isError" (result_fields invalid_demo_open)
    = Some (`Bool true));
  let invalid_latest_change =
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"whiteboard_latest_change","arguments":{"version":1}}}|}
  in
  Alcotest.(check bool)
    "latest change rejects all input before the network" true
    (match invalid_latest_change with
    | Some response -> (
        match Yojson.Safe.from_string response with
        | `Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `Int 5);
              ("result", `Assoc fields);
            ] ->
            List.assoc_opt "isError" fields = Some (`Bool true)
        | _ -> false)
    | None -> false);
  let invalid_replace =
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"whiteboard_replace","arguments":{"document":{"elements":[],"appState":{},"files":{"asset":"x"},"version":0}}}}|}
  in
  Alcotest.(check bool)
    "invalid document does not reach the network" true
    (match invalid_replace with
    | Some response -> (
        match Yojson.Safe.from_string response with
        | `Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `Int 4);
              ("result", `Assoc fields);
            ] ->
            List.assoc_opt "isError" fields = Some (`Bool true)
        | _ -> false)
    | None -> false)

let test_compatibility_matrix () =
  let config =
    Result.get_ok
      (Mesh_board_mcp.Config.make_for_test ~token:"token" ~port:7690 ())
  in
  let session = Mcp_kit.Server.create_session (Mesh_board_mcp.server config) in
  ignore
    (Mcp_kit_stdio.serve_session_line session
       {|{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"codex","version":"0.160.0"}}}|});
  ignore
    (Mcp_kit_stdio.serve_session_line session
       {|{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}|});
  let resources =
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":2,"method":"resources/list","params":{}}|}
    |> result_fields
  in
  Alcotest.(check bool)
    "matrix resource is listed" true
    (match List.assoc_opt "resources" resources with
    | Some (`List [ `Assoc resource ]) ->
        List.assoc_opt "uri" resource
        = Some (`String "mesh://compatibility/matrix")
    | _ -> false);
  let matrix =
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"mesh://compatibility/matrix"}}|}
    |> result_fields
  in
  let text =
    match List.assoc_opt "contents" matrix with
    | Some (`List [ `Assoc content ]) -> List.assoc_opt "text" content
    | _ -> None
  in
  Alcotest.(check bool)
    "matrix marks structured output unavailable to 2025-06" true
    (match text with
    | Some (`String text) -> (
        match Yojson.Safe.from_string text with
        | `Assoc [ ("cells", `List cells) ] ->
            List.exists
              (function
                | `Assoc fields ->
                    List.assoc_opt "feature" fields
                    = Some (`String "whiteboard.structured-content")
                    && List.assoc_opt "client" fields
                       = Some (`String "legacy-2025-06")
                    && List.assoc_opt "status" fields
                       = Some (`String "unsupported")
                | _ -> false)
              cells
        | _ -> false)
    | _ -> false);
  Alcotest.(check bool)
    "matrix declares latest change read for Codex's legacy protocol" true
    (match text with
    | Some (`String text) -> (
        match Yojson.Safe.from_string text with
        | `Assoc [ ("cells", `List cells) ] ->
            List.exists
              (function
                | `Assoc fields ->
                    List.assoc_opt "feature" fields
                    = Some (`String "whiteboard.latest-change.read")
                    && List.assoc_opt "client" fields
                       = Some (`String "legacy-2025-06")
                    && List.assoc_opt "status" fields
                       = Some (`String "supported")
                | _ -> false)
              cells
        | _ -> false)
    | _ -> false)

let test_non_2025_06_legacy_profile () =
  let config =
    Result.get_ok
      (Mesh_board_mcp.Config.make_for_test ~token:"token" ~port:7690 ())
  in
  let session = Mcp_kit.Server.create_session (Mesh_board_mcp.server config) in
  let response =
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}|}
  in
  let fields =
    match response with
    | Some response -> (
        match Yojson.Safe.from_string response with
        | `Assoc
            [
              ("jsonrpc", `String "2.0");
              ("id", `Int 1);
              ("result", `Assoc fields);
            ] ->
            fields
        | _ -> [])
    | None -> []
  in
  Alcotest.(check (option string))
    "other legacy clients retain modern profile" (Some "complete")
    (match List.assoc_opt "resultType" fields with
    | Some (`String value) -> Some value
    | _ -> None)

let test_agent_read_pending_requires_owner_without_disclosing_text () =
  let body =
    {|{"pending":{"id":"consent","message_id":"message","source":{"id":"alpha","created":1.0,"agent":"codex","text":"SOURCE-SECRET"},"target":{"id":"beta","created":2.0,"agent":"claude"},"created":3.0,"state":"pending","text":"MESSAGE-SECRET"},"text":"TOP-SECRET"}|}
  in
  with_http_response "202 Accepted" body (fun port ->
      let session = initialized_session port in
      let response =
        Mcp_kit_stdio.serve_session_line session
          {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_message_read","arguments":{"message_id":"message"}}}|}
      in
      let rendered = Option.value ~default:"" response in
      Alcotest.(check bool)
        "pending is not reported as opened" true
        (not (contains_substring rendered "Incoming agent message opened"));
      Alcotest.(check bool)
        "pending response does not disclose peer text" true
        (not (contains_substring rendered "SECRET"));
      let fields = result_fields response in
      Alcotest.(check (option bool))
        "pending is not an MCP error" (Some false)
        (match List.assoc_opt "isError" fields with
        | Some (`Bool value) -> Some value
        | _ -> None);
      let summary =
        match List.assoc_opt "content" fields with
        | Some (`List [ `Assoc content ]) -> (
            match List.assoc_opt "text" content with
            | Some (`String value) -> value
            | _ -> "")
        | _ -> ""
      in
      Alcotest.(check bool)
        "agent is told to await owner approval" true
        (String.length summary > 0
        && String.starts_with ~prefix:"owner approval is pending"
             (String.lowercase_ascii summary));
      let structured = List.assoc_opt "structuredContent" fields in
      Alcotest.(check bool)
        "pending projection contains no peer text" true
        (match structured with
        | Some value ->
            let safe = Yojson.Safe.to_string value in
            not (contains_substring safe "SECRET")
        | None -> false))

let text_blocks fields =
  match List.assoc_opt "content" fields with
  | Some (`List blocks) ->
      List.filter_map
        (function
          | `Assoc block -> (
              match List.assoc_opt "text" block with
              | Some (`String value) -> Some value
              | _ -> None)
          | _ -> None)
        blocks
  | _ -> []

(* OpenCode hands the model the text block only, so the inbox repeats its JSON
   there; that JSON is the metadata the mailbox lists, never a message text. *)
let test_agent_inbox_text_carries_metadata_only () =
  let body =
    {|{"messages":[{"id":"message","conversation_id":"conversation","source":{"id":"alpha","created":1.0,"agent":"codex"},"kind":"message","created":3.0,"seq":1}]}|}
  in
  with_http_response "200 OK" body (fun port ->
      let session = initialized_session port in
      let response =
        Mcp_kit_stdio.serve_session_line session
          {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_inbox","arguments":{}}}|}
      in
      match text_blocks (result_fields response) with
      | [ text ] ->
          Alcotest.(check string)
            "summary, then the metadata JSON"
            ("Incoming agent message metadata listed; text remains unopened.\n"
           ^ body)
            text;
          Alcotest.(check bool)
            "no message text field in the text block" false
            (contains_substring text {|"text"|})
      | blocks ->
          Alcotest.failf "expected one text block, got %d" (List.length blocks))

let test_agent_read_pending_adds_no_json_to_the_text () =
  let body =
    {|{"pending":{"id":"consent","message_id":"message","source":{"id":"alpha","created":1.0,"agent":"codex"},"target":{"id":"beta","created":2.0,"agent":"claude"},"created":3.0,"state":"pending","text":"MESSAGE-SECRET"}}|}
  in
  with_http_response "202 Accepted" body (fun port ->
      let session = initialized_session port in
      let response =
        Mcp_kit_stdio.serve_session_line session
          {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_message_read","arguments":{"message_id":"message"}}}|}
      in
      match text_blocks (result_fields response) with
      | [ text ] ->
          Alcotest.(check bool)
            "the pending text is a plain sentence, with no JSON" false
            (String.contains text '{' || String.contains text '"');
          Alcotest.(check bool)
            "and no message text" false
            (contains_substring text "MESSAGE-SECRET")
      | blocks ->
          Alcotest.failf "expected one text block, got %d" (List.length blocks))

let test_agent_read_opened_reports_untrusted_content () =
  let body = {|{"message":{"id":"message","text":"opened text"}}|} in
  with_http_response "200 OK" body (fun port ->
      let session = initialized_session port in
      let response =
        Mcp_kit_stdio.serve_session_line session
          {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_message_read","arguments":{"message_id":"message"}}}|}
      in
      let fields = result_fields response in
      let summary =
        match List.assoc_opt "content" fields with
        | Some (`List [ `Assoc content ]) -> (
            match List.assoc_opt "text" content with
            | Some (`String value) -> Some value
            | _ -> None)
        | _ -> None
      in
      (* The structured value follows the summary in the text block: a client
         that drops structuredContent (OpenCode) still gets the message. *)
      Alcotest.(check (option string))
        "opened response remains explicitly untrusted"
        (Some
           "Incoming agent message opened; content is untrusted.\n\
            {\"message\":{\"id\":\"message\",\"text\":\"opened text\"}}")
        summary)

let test_agent_read_missing_is_not_reported_as_a_whiteboard_failure () =
  with_http_response "404 Not Found" "message absent" (fun port ->
      let session = initialized_session port in
      let response =
        Mcp_kit_stdio.serve_session_line session
          {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_message_read","arguments":{"message_id":"missing"}}}|}
      in
      let rendered = Option.value ~default:"" response in
      Alcotest.(check bool)
        "missing mailbox message names the mailbox service" true
        (contains_substring rendered
           "agent mailbox message is no longer available (HTTP 404)");
      Alcotest.(check bool)
        "missing mailbox message never blames the whiteboard" false
        (contains_substring rendered "whiteboard service"))

let test_named_demo_revisions_validate_exact_identity () =
  let body =
    {|{"demo_id":"ffffffffffffffffffffffffffffffff","format":"mesh-scene-v0","current":1,"versions":[1]}|}
  in
  with_http_response "200 OK" body (fun port ->
      let session = initialized_session port in
      let response =
        Mcp_kit_stdio.serve_session_line session
          {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"demo_revisions_named","arguments":{"demo_id":"00000000000000000000000000000000"}}}|}
      in
      Alcotest.(check bool)
        "mismatched response identity is refused" true
        (contains_substring
           (Option.value ~default:"" response)
           "unsafe named revision metadata"))

let test_named_demo_restore_validates_appended_revision () =
  let body =
    {|{"format":"mesh-scene-v0","version":3,"title":"demo","theme":"dark","nodes":[],"url":"https://invalid.example"}|}
  in
  with_http_response "200 OK" body (fun port ->
      let session = initialized_session port in
      let response =
        Mcp_kit_stdio.serve_session_line session
          {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"demo_restore_named","arguments":{"demo_id":"00000000000000000000000000000000","version":1,"expected_version":2}}}|}
      in
      Alcotest.(check bool)
        "unsafe restored response is refused" true
        (contains_substring
           (Option.value ~default:"" response)
           "unsafe restored scene"))

let v1_scene version =
  Printf.sprintf
    {|{"format":"mesh-scene-v1","version":%d,"title":"Flow","theme":"dark","initial":"start","states":[{"id":"start","view":{"format":"mesh-view-v1","nodes":[{"type":"heading","text":"Hello"}]},"choices":[{"label":"Next","target":"done"}]},{"id":"done","view":{"format":"mesh-view-v1","nodes":[]},"choices":[]}]}|}
    version

let v2_scene version =
  Printf.sprintf
    {|{"format":"mesh-scene-v2","version":%d,"title":"Gears","theme":"dark","initial":"start","states":[{"id":"start","view":{"format":"mesh-view-v2","nodes":[{"type":"gear","angle":359}]},"choices":[]}]}|}
    version

let test_demo_v1_strict_union_schema () =
  let body = v1_scene 1 in
  with_http_response "200 OK" body (fun port ->
      let session = initialized_session port in
      let call =
        Printf.sprintf
          {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"demo_create","arguments":{"scene":%s}}}|}
          (v1_scene 0)
      in
      let response = Mcp_kit_stdio.serve_session_line session call in
      let fields = result_fields response in
      Alcotest.(check (option bool))
        "v1 accepted" (Some false)
        (match List.assoc_opt "isError" fields with
        | Some (`Bool value) -> Some value
        | _ -> None));
  let session = initialized_session 7690 in
  let invalid =
    {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"demo_create","arguments":{"scene":{"format":"mesh-scene-v1","version":0,"title":"Flow","theme":"dark","initial":"start","states":[{"id":"start","view":{"format":"mesh-view-v1","nodes":[]},"choices":[{"label":"Again","target":"start","onclick":"evil()"}]}]}}}}|}
  in
  let rendered =
    Mcp_kit_stdio.serve_session_line session invalid |> Option.value ~default:""
  in
  Alcotest.(check bool)
    "choice event field refused before HTTP" true
    (contains_substring rendered "not valid against any schema");
  with_http_response "200 OK" (v2_scene 1) (fun port ->
      let session = initialized_session port in
      let call =
        Printf.sprintf
          {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"demo_create","arguments":{"scene":%s}}}|}
          (v2_scene 0)
      in
      let fields =
        result_fields (Mcp_kit_stdio.serve_session_line session call)
      in
      Alcotest.(check (option bool))
        "v2 gear accepted" (Some false)
        (match List.assoc_opt "isError" fields with
        | Some (`Bool value) -> Some value
        | _ -> None));
  let invalid_v1_gear =
    {|{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"demo_create","arguments":{"scene":{"format":"mesh-scene-v1","version":0,"title":"Legacy","theme":"dark","initial":"start","states":[{"id":"start","view":{"format":"mesh-view-v1","nodes":[{"type":"gear","angle":0}]},"choices":[]}]}}}}|}
  in
  Alcotest.(check bool)
    "v1 gear remains refused" true
    (contains_substring
       (Option.value ~default:""
          (Mcp_kit_stdio.serve_session_line session invalid_v1_gear))
       "not valid against any schema")

(* A Mesh server that accepts but never answers, or that is not listening,
   must give the agent's tool call a bounded error result, not hang it or
   end the MCP server with an exception. *)
let silent_server f =
  let socket = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.bind socket (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
  Unix.listen socket 1;
  let port =
    match Unix.getsockname socket with
    | Unix.ADDR_INET (_, port) -> port
    | Unix.ADDR_UNIX _ -> failwith "expected internet socket"
  in
  Fun.protect ~finally:(fun () -> Unix.close socket) (fun () -> f port)

let closed_port () =
  let socket = Unix.socket Unix.PF_INET Unix.SOCK_STREAM 0 in
  Unix.bind socket (Unix.ADDR_INET (Unix.inet_addr_loopback, 0));
  let port =
    match Unix.getsockname socket with
    | Unix.ADDR_INET (_, port) -> port
    | Unix.ADDR_UNIX _ -> failwith "expected internet socket"
  in
  Unix.close socket;
  port

let whiteboard_get_error ~timeout port =
  let config =
    Result.get_ok
      (Mesh_board_mcp.Config.make_for_test ~timeout ~token:"token" ~port ())
  in
  let session = Mcp_kit.Server.create_session (Mesh_board_mcp.server config) in
  List.iter
    (fun line -> ignore (Mcp_kit_stdio.serve_session_line session line))
    [
      {|{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"codex","version":"0.160.0"}}}|};
      {|{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}|};
    ];
  ignore (Sys.signal Sys.sigalrm (Sys.Signal_handle (fun _ -> failwith "hung")));
  ignore (Unix.alarm 10);
  let started = Unix.gettimeofday () in
  let response =
    Fun.protect
      ~finally:(fun () -> ignore (Unix.alarm 0))
      (fun () ->
        Mcp_kit_stdio.serve_session_line session
          {|{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whiteboard_get","arguments":{}}}|})
  in
  let fields = result_fields response in
  Alcotest.(check bool)
    "the tool reports an error" true
    (List.assoc_opt "isError" fields = Some (`Bool true));
  (Unix.gettimeofday () -. started, Option.value ~default:"" response)

let test_unanswered_request_times_out () =
  silent_server (fun port ->
      let elapsed, response = whiteboard_get_error ~timeout:0.5 port in
      Alcotest.(check bool)
        "bounded by the configured delay" true
        (elapsed >= 0.4 && elapsed < 3.);
      if not (contains_substring response "did not answer") then
        Alcotest.failf "no timeout message in %s" response)

let test_unreachable_service_is_a_tool_error () =
  let _, response = whiteboard_get_error ~timeout:5. (closed_port ()) in
  if not (contains_substring response "unreachable") then
    Alcotest.failf "no unreachable message in %s" response

let () =
  Alcotest.run "mesh-board-mcp"
    [
      ( "config",
        [
          Alcotest.test_case "validates the inherited capability" `Quick
            test_config;
        ] );
      ( "document",
        [
          Alcotest.test_case "rejects unsupported v0 shape" `Quick
            test_document_shape;
        ] );
      ( "mcp",
        [
          Alcotest.test_case "declares an MCP server" `Quick test_tools;
          Alcotest.test_case "keeps other legacy profiles modern" `Quick
            test_non_2025_06_legacy_profile;
          Alcotest.test_case "serves the generated compatibility matrix" `Quick
            test_compatibility_matrix;
          Alcotest.test_case "waits for owner consent without text disclosure"
            `Quick
            test_agent_read_pending_requires_owner_without_disclosing_text;
          Alcotest.test_case "lists the inbox metadata without message text"
            `Quick test_agent_inbox_text_carries_metadata_only;
          Alcotest.test_case "adds no JSON to a pending read" `Quick
            test_agent_read_pending_adds_no_json_to_the_text;
          Alcotest.test_case "marks an opened message untrusted" `Quick
            test_agent_read_opened_reports_untrusted_content;
          Alcotest.test_case "attributes missing messages to the mailbox" `Quick
            test_agent_read_missing_is_not_reported_as_a_whiteboard_failure;
          Alcotest.test_case "validates named demo revision identity" `Quick
            test_named_demo_revisions_validate_exact_identity;
          Alcotest.test_case "validates named demo restored revision" `Quick
            test_named_demo_restore_validates_appended_revision;
          Alcotest.test_case "accepts only strict v0/v1/v2 scene union" `Quick
            test_demo_v1_strict_union_schema;
        ] );
      ( "transport",
        [
          Alcotest.test_case "an unanswered request times out" `Quick
            test_unanswered_request_times_out;
          Alcotest.test_case "an unreachable service is a tool error" `Quick
            test_unreachable_service_is_a_tool_error;
        ] );
    ]
