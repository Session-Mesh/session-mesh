(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                        *)
(*                                                                            *)
(******************************************************************************)

(* The session action tools of mesh-board against a one-shot fake Mesh server
   that records the request it got: which route and body each tool sends, and
   that a refusal reaches the agent with the server's cause (code and message)
   instead of a bare HTTP status. *)

let contains haystack needle =
  let rec loop offset =
    offset + String.length needle <= String.length haystack
    && (String.sub haystack offset (String.length needle) = needle
       || loop (offset + 1))
  in
  needle = "" || loop 0

let rec waitpid_retrying child =
  try Unix.waitpid [] child
  with Unix.Unix_error (Unix.EINTR, _, _) -> waitpid_retrying child

(* Serve one request with [status] and [body]; [f port] runs the client; the
   raw request (request line, headers, body) is returned with [f]'s result. *)
let with_server ?(content_type = "application/json") status body f =
  let recorded = Filename.temp_file "board-request-" ".txt" in
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
      let buffer = Bytes.create 65536 in
      let length = Unix.read client buffer 0 (Bytes.length buffer) in
      let out = open_out_bin recorded in
      output out buffer 0 length;
      close_out out;
      let response =
        Printf.sprintf
          "HTTP/1.1 %s\r\n\
           Content-Type: %s\r\n\
           Content-Length: %d\r\n\
           Connection: close\r\n\
           \r\n\
           %s"
          status content_type (String.length body) body
      in
      ignore (Unix.write_substring client response 0 (String.length response));
      Unix.close client;
      Unix.close socket;
      exit 0
  | child ->
      let result =
        Fun.protect
          ~finally:(fun () ->
            Unix.close socket;
            ignore (waitpid_retrying child))
          (fun () -> f port)
      in
      let request = In_channel.with_open_bin recorded In_channel.input_all in
      Sys.remove recorded;
      (result, request)

let call port name arguments =
  let config =
    Result.get_ok (Mesh_board_mcp.Config.make_for_test ~token:"token" ~port ())
  in
  let session = Mcp_kit.Server.create_session (Mesh_board_mcp.server config) in
  List.iter
    (fun line -> ignore (Mcp_kit_stdio.serve_session_line session line))
    [
      {|{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"claude-code","version":"2.1.0"}}}|};
      {|{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}|};
    ];
  let line =
    Yojson.Safe.to_string
      (`Assoc
         [
           ("jsonrpc", `String "2.0");
           ("id", `Int 2);
           ("method", `String "tools/call");
           ( "params",
             `Assoc [ ("name", `String name); ("arguments", arguments) ] );
         ])
  in
  match Mcp_kit_stdio.serve_session_line session line with
  | None -> Alcotest.fail "no answer"
  | Some answer -> (
      match Yojson.Safe.from_string answer with
      | `Assoc fields -> (
          match List.assoc_opt "result" fields with
          | Some (`Assoc result) ->
              let is_error =
                List.assoc_opt "isError" result = Some (`Bool true)
              in
              let text =
                match List.assoc_opt "content" result with
                | Some (`List blocks) ->
                    String.concat "\n"
                      (List.filter_map
                         (function
                           | `Assoc block -> (
                               match List.assoc_opt "text" block with
                               | Some (`String text) -> Some text
                               | _ -> None)
                           | _ -> None)
                         blocks)
                | _ -> ""
              in
              (is_error, text)
          | _ -> Alcotest.failf "no result in %s" answer)
      | _ -> Alcotest.failf "not an object: %s" answer)

let request_line request =
  match String.index_opt request '\r' with
  | Some index -> String.sub request 0 index
  | None -> request

let request_body request =
  let marker = "\r\n\r\n" in
  let rec find offset =
    if offset + 4 > String.length request then ""
    else if String.sub request offset 4 = marker then
      String.sub request (offset + 4) (String.length request - offset - 4)
    else find (offset + 1)
  in
  find 0

let accounts_answer =
  {|{"agent":"claude","current":{"id":"default","label":"Default account","declared":true},"accounts":[{"id":"default","label":"Default account","claude":true,"codex":true},{"id":"travel","label":"Travel","claude":true,"codex":false}],"accounts_file":"ok","switch_qualified":false}|}

let test_session_accounts_reads_the_self_route () =
  let (is_error, text), request =
    with_server "200 OK" accounts_answer (fun port ->
        call port "session_accounts" (`Assoc []))
  in
  Alcotest.(check bool) "not an error" false is_error;
  Alcotest.(check string)
    "a GET of the session's own route, with no parameter"
    "GET /api/session-actions/@self/accounts HTTP/1.1" (request_line request);
  Alcotest.(check bool)
    "the session token authenticates it" true
    (contains request "MeshSession token");
  Alcotest.(check bool)
    "the agent sees the server's answer" true
    (contains text {|"id":"travel","label":"Travel"|})

(* The agent kind and the session are the server's to know: no argument at
   all is accepted, so none can be forwarded. *)
let test_session_accounts_takes_no_argument () =
  List.iter
    (fun arguments ->
      let is_error, text = call 9 "session_accounts" arguments in
      Alcotest.(check bool)
        ("refused before the network: " ^ Yojson.Safe.to_string arguments)
        true is_error;
      Alcotest.(check bool)
        "never reaches the server" false
        (contains text "unreachable"))
    [
      `Assoc [ ("agent", `String "codex") ];
      `Assoc [ ("session", `String "other") ];
      `Assoc [ ("account", `String "travel") ];
    ]

let test_a_coded_refusal_reaches_the_agent () =
  let body =
    {|{"error":{"code":"account_unknown","message":"No account \"trav\" is declared. Available: default, travel."}}|}
  in
  let (is_error, text), request =
    with_server "400 Bad Request" body (fun port ->
        call port "session_restart_request" (`Assoc []))
  in
  Alcotest.(check string)
    "the restart request is posted"
    "POST /api/session-actions/@self/request HTTP/1.1" (request_line request);
  Alcotest.(check string)
    "its body" {|{"action":"restart"}|} (request_body request);
  Alcotest.(check bool) "an error" true is_error;
  Alcotest.(check bool) "with the code" true (contains text "account_unknown");
  Alcotest.(check bool)
    "and the server's message" true
    (contains text
       {|No account \"trav\" is declared. Available: default, travel.|}
    || contains text
         {|No account "trav" is declared. Available: default, travel.|});
  Alcotest.(check bool) "and the status" true (contains text "HTTP 400");
  Alcotest.(check bool)
    "never blamed on the whiteboard" false
    (contains text "whiteboard")

let test_a_plain_text_refusal_reaches_the_agent () =
  let (is_error, text), _ =
    with_server ~content_type:"text/plain; charset=utf-8" "409 Conflict"
      "Agent to resume unavailable" (fun port ->
        call port "session_create_request"
          (`Assoc [ ("preset", `String "claude") ]))
  in
  Alcotest.(check bool) "an error" true is_error;
  Alcotest.(check bool)
    "the server's text" true
    (contains text "Agent to resume unavailable");
  Alcotest.(check bool) "and the status" true (contains text "HTTP 409")

(* The cause is shown to the agent and repeated to the owner: no control
   character (a terminal escape, a line feed that would fake a second line)
   and a bounded length. *)
let test_the_cause_is_cleaned_and_bounded () =
  let hostile =
    "first\027[31m\nsecond\r\xc2\x9b31m\xe2\x80\xaeevil\xe2\x80\xa8"
    ^ String.make 5000 'x'
  in
  let body =
    Yojson.Safe.to_string
      (`Assoc
         [
           ( "error",
             `Assoc
               [ ("code", `String "bad\ncode"); ("message", `String hostile) ]
           );
         ])
  in
  let (is_error, text), _ =
    with_server "400 Bad Request" body (fun port ->
        call port "session_restart_request" (`Assoc []))
  in
  Alcotest.(check bool) "an error" true is_error;
  Alcotest.(check bool)
    "no escape character" false
    (String.contains text '\027');
  Alcotest.(check bool) "no carriage return" false (String.contains text '\r');
  Alcotest.(check bool)
    "no 8-bit control sequence introducer" false
    (contains text "\xc2\x9b");
  Alcotest.(check bool)
    "no bidirectional override" false
    (contains text "\xe2\x80\xae");
  Alcotest.(check bool)
    "no line separator" false
    (contains text "\xe2\x80\xa8");
  Alcotest.(check bool)
    "no line feed inside the cause" false (contains text "first\n");
  Alcotest.(check bool)
    "a malformed code is not presented as a code" false (contains text "bad");
  Alcotest.(check bool) "bounded" true (String.length text < 1200)

let test_an_unknown_request_is_explained () =
  let (is_error, text), request =
    with_server ~content_type:"text/plain; charset=utf-8" "404 Not Found"
      "404: Not Found" (fun port ->
        call port "session_action_status"
          (`Assoc [ ("request_id", `String "abc") ]))
  in
  Alcotest.(check string)
    "the status is read"
    "GET /api/session-actions/@self/request?id=abc HTTP/1.1"
    (request_line request);
  Alcotest.(check bool) "an error" true is_error;
  Alcotest.(check bool)
    "expired, or made by another incarnation" true
    (contains text "expired" && contains text "session_accounts")

(* Slice A has no tool that changes the account: neither the tool description
   nor the 404 explanation may promise one, and the field that says which
   agent kinds run under an alias must not be named as a switch. *)
let test_accounts_tool_does_not_promise_a_switch () =
  let config =
    Result.get_ok
      (Mesh_board_mcp.Config.make_for_test ~token:"token" ~port:9 ())
  in
  let session = Mcp_kit.Server.create_session (Mesh_board_mcp.server config) in
  List.iter
    (fun line -> ignore (Mcp_kit_stdio.serve_session_line session line))
    [
      {|{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"claude-code","version":"2.1.0"}}}|};
      {|{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}|};
    ];
  let answer =
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}|}
  in
  let description =
    match Option.map Yojson.Safe.from_string answer with
    | Some (`Assoc fields) -> (
        match List.assoc_opt "result" fields with
        | Some (`Assoc result) -> (
            match List.assoc_opt "tools" result with
            | Some (`List tools) ->
                List.find_map
                  (function
                    | `Assoc tool
                      when List.assoc_opt "name" tool
                           = Some (`String "session_accounts") -> (
                        match List.assoc_opt "description" tool with
                        | Some (`String text) -> Some text
                        | _ -> None)
                    | _ -> None)
                  tools
            | _ -> None)
        | _ -> None)
    | _ -> None
  in
  match description with
  | None -> Alcotest.fail "session_accounts is not listed"
  | Some text ->
      let lower = String.lowercase_ascii text in
      Alcotest.(check bool)
        "the description does not mention switching" false
        (contains lower "switch");
      Alcotest.(check bool)
        "the description says there is no switch tool" true
        (contains lower "no tool to change")

let test_the_unknown_request_text_does_not_promise_a_switch () =
  let (_, text), _ =
    with_server ~content_type:"text/plain; charset=utf-8" "404 Not Found"
      "404: Not Found" (fun port ->
        call port "session_action_status"
          (`Assoc [ ("request_id", `String "abc") ]))
  in
  Alcotest.(check bool)
    "no switched session is mentioned" false
    (contains (String.lowercase_ascii text) "switch")


let () =
  Alcotest.run "mesh-board-session-actions"
    [
      ( "session_accounts",
        [
          Alcotest.test_case "does not promise an account switch" `Quick
            test_accounts_tool_does_not_promise_a_switch;
          Alcotest.test_case "the 404 text does not promise a switch" `Quick
            test_the_unknown_request_text_does_not_promise_a_switch;
          Alcotest.test_case "reads the session's own accounts route" `Quick
            test_session_accounts_reads_the_self_route;
          Alcotest.test_case "takes no argument" `Quick
            test_session_accounts_takes_no_argument;
        ] );
      ( "refusals",
        [
          Alcotest.test_case "a coded refusal reaches the agent" `Quick
            test_a_coded_refusal_reaches_the_agent;
          Alcotest.test_case "a plain text refusal reaches the agent" `Quick
            test_a_plain_text_refusal_reaches_the_agent;
          Alcotest.test_case "the cause is cleaned and bounded" `Quick
            test_the_cause_is_cleaned_and_bounded;
          Alcotest.test_case "an unknown request is explained" `Quick
            test_an_unknown_request_is_explained;
        ] );
    ]
