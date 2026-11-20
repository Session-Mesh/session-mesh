(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The agent guide served by mesh-board-mcp is ocaml/lib/agent-guide.md, byte
   for byte. The test receives that file's path as its first argument.
   tests/agent-guide-copy.test.ts checks that this file is identical to the
   repository's docs/agent-guide.md. *)

let guide_path () =
  if Array.length Sys.argv < 2 then failwith "usage: agent_guide_test GUIDE.md"
  else Sys.argv.(1)

let read_file path = In_channel.with_open_bin path In_channel.input_all

let contains haystack needle =
  let hay = String.length haystack and len = String.length needle in
  let rec loop offset =
    offset + len <= hay
    && (String.sub haystack offset len = needle || loop (offset + 1))
  in
  len = 0 || loop 0

let open_session protocol server =
  let session = Mcp_kit.Server.create_session server in
  let initialize =
    Printf.sprintf
      {|{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"%s","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}|}
      protocol
  in
  let response = Mcp_kit_stdio.serve_session_line session initialize in
  ignore
    (Mcp_kit_stdio.serve_session_line session
       {|{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}|});
  (session, response)

(* Port 9 (discard) is never contacted: the guide tool makes no request. *)
let session protocol =
  let config =
    Result.get_ok
      (Mesh_board_mcp.Config.make_for_test ~token:"token" ~port:9 ())
  in
  open_session protocol (Mesh_board_mcp.server config)

let result_of id response =
  match Option.map Yojson.Safe.from_string response with
  | Some (`Assoc fields) -> (
      match (List.assoc_opt "id" fields, List.assoc_opt "result" fields) with
      | Some (`Int got), Some (`Assoc result) when got = id -> result
      | _ -> Alcotest.failf "no result for request %d" id)
  | _ -> Alcotest.failf "no response for request %d" id

let call session id arguments =
  Mcp_kit_stdio.serve_session_line session
    (Printf.sprintf
       {|{"jsonrpc":"2.0","id":%d,"method":"tools/call","params":{"name":"agent_guide_read","arguments":%s}}|}
       id arguments)
  |> result_of id

let texts result =
  match List.assoc_opt "content" result with
  | Some (`List items) ->
      List.filter_map
        (function
          | `Assoc item -> (
              match List.assoc_opt "text" item with
              | Some (`String text) -> Some text
              | _ -> None)
          | _ -> None)
        items
  | _ -> []

let is_error result = List.assoc_opt "isError" result = Some (`Bool true)

let served_text_is_the_file protocol () =
  let expected = read_file (guide_path ()) in
  Alcotest.(check bool)
    "the guide file is a Markdown document" true
    (String.length expected > 0 && String.starts_with ~prefix:"# " expected);
  let session, _ = session protocol in
  let result = call session 2 "{}" in
  Alcotest.(check bool) "not an error" false (is_error result);
  Alcotest.(check (list string))
    "exactly lib/agent-guide.md" [ expected ] (texts result)

let instructions_point_to_the_guide () =
  let _, response = session "2025-06-18" in
  match List.assoc_opt "instructions" (result_of 1 response) with
  | Some (`String text) ->
      Alcotest.(check bool)
        "names the session-mesh context and the tool" true
        (contains text "session-mesh" && contains text "agent_guide_read")
  | _ -> Alcotest.fail "initialize carries no instructions"

let tool_declaration () =
  let session, _ = session "2025-06-18" in
  let tools =
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}|}
    |> result_of 2 |> List.assoc_opt "tools"
  in
  let declaration =
    match tools with
    | Some (`List tools) ->
        List.find_map
          (function
            | `Assoc fields
              when List.assoc_opt "name" fields
                   = Some (`String "agent_guide_read") ->
                Some fields
            | _ -> None)
          tools
    | _ -> None
  in
  match declaration with
  | None -> Alcotest.fail "agent_guide_read is not listed"
  | Some fields ->
      Alcotest.(check bool)
        "the description itself says where the agent runs" true
        (match List.assoc_opt "description" fields with
        | Some (`String text) -> contains text "session-mesh"
        | _ -> false);
      Alcotest.(check bool)
        "no parameter is accepted" true
        (match List.assoc_opt "inputSchema" fields with
        | Some (`Assoc schema) -> (
            List.assoc_opt "additionalProperties" schema = Some (`Bool false)
            &&
            match List.assoc_opt "properties" schema with
            | None | Some (`Assoc []) -> true
            | _ -> false)
        | _ -> false)

(* Slice A has no account switching tool: the guide must say so and must not
   suggest the agent can change its account. *)
let guide_does_not_promise_an_account_switch () =
  let guide = read_file (guide_path ()) in
  Alcotest.(check bool)
    "says there is no tool to change the account" true
    (contains guide "no tool to change your account");
  Alcotest.(check bool)
    "does not say the agent can change account" false
    (contains guide "can change account" || contains guide "switch_supported");
  Alcotest.(check bool)
    "names the switch_qualified field" true
    (contains guide "`switch_qualified`");
  Alcotest.(check bool)
    "no longer names aliases_supported" false
    (contains guide "aliases_supported")


let rejects_a_path_argument () =
  let guide = read_file (guide_path ()) in
  let session, _ = session "2025-06-18" in
  let result = call session 2 {|{"path":"/etc/passwd"}|} in
  Alcotest.(check bool) "an error" true (is_error result);
  Alcotest.(check bool)
    "the guide is not returned" false
    (List.mem guide (texts result))

(* The tracker section of the guide names the work_* tools. Their list comes
   from the real work-mcp server (tools/list), so a tool added, renamed or
   removed there fails here until the guide follows. *)
let work_tools () =
  let session, _ = open_session "2025-06-18" (Work_mcp.Work_server.server ()) in
  match
    Mcp_kit_stdio.serve_session_line session
      {|{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}|}
    |> result_of 2 |> List.assoc_opt "tools"
  with
  | Some (`List tools) ->
      List.filter_map
        (function
          | `Assoc fields -> (
              match List.assoc_opt "name" fields with
              | Some (`String name) -> Some name
              | _ -> None)
          | _ -> None)
        tools
      |> List.sort_uniq compare
  | _ -> Alcotest.fail "work-mcp lists no tools"

(* Every "work_" followed by a lowercase name ("work_*" names none). *)
let work_names text =
  let len = String.length text in
  let is_name_char c = (c >= 'a' && c <= 'z') || c = '_' in
  let rec scan i found =
    if i + 5 > len then found
    else if String.sub text i 5 = "work_" && (i = 0 || not (is_name_char text.[i - 1])) then (
      let j = ref (i + 5) in
      while !j < len && is_name_char text.[!j] do incr j done;
      let found = if !j > i + 5 then String.sub text i (!j - i) :: found else found in
      scan !j found)
    else scan (i + 1) found
  in
  scan 0 [] |> List.sort_uniq compare

let guide_names_exactly_the_work_tools () =
  let tools = work_tools () in
  Alcotest.(check int) "work-mcp has 19 tools" 19 (List.length tools);
  Alcotest.(check (list string))
    "the guide names every work_* tool and no other" tools
    (work_names (read_file (guide_path ())))

let work_instructions_name_real_tools () =
  let tools = work_tools () in
  List.iter
    (fun name ->
      Alcotest.(check bool)
        (name ^ " in the work-mcp instructions is a real tool") true
        (List.mem name tools))
    (work_names Work_mcp.Work_instructions.text)

let () =
  (* The guide path is ours; Alcotest must not parse it as a command. *)
  Alcotest.run
    ~argv:[| Sys.argv.(0) |]
    "agent-guide"
    [
      ( "agent_guide_read",
        [
          Alcotest.test_case "serves the file (2025-06 profile)" `Quick
            (served_text_is_the_file "2025-06-18");
          Alcotest.test_case "serves the file (2025-11 profile)" `Quick
            (served_text_is_the_file "2025-11-25");
          Alcotest.test_case "server instructions name the guide" `Quick
            instructions_point_to_the_guide;
          Alcotest.test_case "declared without parameters" `Quick
            tool_declaration;
          Alcotest.test_case "promises no account switch" `Quick
            guide_does_not_promise_an_account_switch;
          Alcotest.test_case "rejects a path argument" `Quick
            rejects_a_path_argument;
        ] );
      ( "tracker section",
        [
          Alcotest.test_case "names exactly the work-mcp tools" `Quick
            guide_names_exactly_the_work_tools;
          Alcotest.test_case "work-mcp instructions name real tools" `Quick
            work_instructions_name_real_tools;
        ] );
    ]
