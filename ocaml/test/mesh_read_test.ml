(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let sid = "0a1b2c3d-1111-2222-3333-444455556666"
let codex_sid = "019a0000-aaaa-bbbb-cccc-ddddeeeeffff"

let with_root f =
  let root = Filename.temp_file "mesh-read" "" in
  Sys.remove root;
  Unix.mkdir root 0o700;
  Fun.protect
    ~finally:(fun () ->
      let rec remove path =
        match (Unix.lstat path).Unix.st_kind with
        | Unix.S_DIR ->
            Sys.readdir path
            |> Array.iter (fun name -> remove (Filename.concat path name));
            Unix.rmdir path
        | _ -> Unix.unlink path
      in
      remove root)
    (fun () -> f root)

let mkdir path = Unix.mkdir path 0o700

let write path lines =
  let channel = open_out_bin path in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () ->
      List.iter
        (fun line -> output_string channel (Yojson.Safe.to_string line ^ "\n"))
        lines)

let append_raw path value =
  let channel =
    open_out_gen [ Open_wronly; Open_append; Open_binary ] 0o600 path
  in
  Fun.protect
    ~finally:(fun () -> close_out_noerr channel)
    (fun () -> output_string channel value)

let claude_fixture root =
  let claude = Filename.concat root ".claude" in
  let projects = Filename.concat claude "projects" in
  let project = Filename.concat projects "-tmp-project" in
  mkdir claude;
  mkdir projects;
  mkdir project;
  let path = Filename.concat project (sid ^ ".jsonl") in
  write path
    [
      `Assoc
        [
          ("type", `String "user");
          ("message", `Assoc [ ("content", `String "hello from user") ]);
        ];
      `Assoc
        [
          ("type", `String "assistant");
          ( "message",
            `Assoc
              [
                ( "content",
                  `List
                    [
                      `Assoc
                        [
                          ("type", `String "thinking");
                          ("thinking", `String "private");
                        ];
                      `Assoc
                        [
                          ("type", `String "text");
                          ("text", `String "hello from assistant");
                        ];
                    ] );
              ] );
        ];
      `Assoc
        [
          ("type", `String "assistant");
          ("isSidechain", `Bool true);
          ("message", `Assoc [ ("content", `String "must not appear") ]);
        ];
    ];
  path

let codex_fixture root =
  let codex = Filename.concat root ".codex" in
  let sessions = Filename.concat codex "sessions" in
  let year = Filename.concat sessions "2026" in
  let month = Filename.concat year "10" in
  let day = Filename.concat month "05" in
  List.iter mkdir [ codex; sessions; year; month; day ];
  let path =
    Filename.concat day ("rollout-2026-10-05T10-00-00-" ^ codex_sid ^ ".jsonl")
  in
  write path
    [
      `Assoc
        [
          ("type", `String "session_meta");
          ("payload", `Assoc [ ("id", `String codex_sid) ]);
        ];
      `Assoc
        [
          ("type", `String "event_msg");
          ( "payload",
            `Assoc
              [
                ("type", `String "user_message");
                ("message", `String "codex user");
              ] );
        ];
      `Assoc
        [
          ("type", `String "event_msg");
          ( "payload",
            `Assoc
              [
                ("type", `String "agent_message");
                ("message", `String "codex agent");
              ] );
        ];
    ]

let config root = Result.get_ok (Mesh_read.Config.make_for_test ~home:root)

let ids (sessions : Mesh_read.session list) =
  List.map
    (fun (session : Mesh_read.session) ->
      (session.Mesh_read.agent, session.Mesh_read.id))
    sessions

let test_list_and_read () =
  with_root (fun root ->
      ignore (claude_fixture root);
      codex_fixture root;
      let store = Mesh_read.Store.create (config root) in
      Alcotest.(check (list (pair string string)))
        "lists only bounded transcript roots"
        [ ("claude", sid); ("codex", codex_sid) ]
        (ids (Result.get_ok (Mesh_read.Store.list_sessions store)));
      let claude =
        Result.get_ok
          (Mesh_read.Store.read_transcript store ~agent:"claude" ~id:sid)
      in
      Alcotest.(check bool)
        "transcript is explicitly untrusted" true claude.untrusted;
      Alcotest.(check (list (pair string string)))
        "only safe user/assistant text"
        [ ("user", "hello from user"); ("assistant", "hello from assistant") ]
        (List.map
           (fun (message : Mesh_read.message) ->
             (message.Mesh_read.role, message.content))
           claude.messages);
      let codex =
        Result.get_ok
          (Mesh_read.Store.read_transcript store ~agent:"codex" ~id:codex_sid)
      in
      Alcotest.(check (list (pair string string)))
        "codex event messages"
        [ ("user", "codex user"); ("assistant", "codex agent") ]
        (List.map
           (fun (message : Mesh_read.message) ->
             (message.Mesh_read.role, message.content))
           codex.messages))

let test_rejects_unbounded_selection () =
  with_root (fun root ->
      ignore (claude_fixture root);
      let store = Mesh_read.Store.create (config root) in
      Alcotest.(check bool)
        "no arbitrary agent" true
        (Result.is_error
           (Mesh_read.Store.read_transcript store ~agent:"other" ~id:sid));
      Alcotest.(check bool)
        "no traversal in id" true
        (Result.is_error
           (Mesh_read.Store.read_transcript store ~agent:"claude"
              ~id:"../../etc/passwd"));
      let outside = Filename.concat root "outside.jsonl" in
      write outside
        [
          `Assoc
            [
              ("type", `String "user");
              ("message", `Assoc [ ("content", `String "no") ]);
            ];
        ];
      Unix.symlink outside
        (Filename.concat root ".claude/projects/-tmp-project/other.jsonl");
      Alcotest.(check (list (pair string string)))
        "symlink transcript excluded"
        [ ("claude", sid) ]
        (ids (Result.get_ok (Mesh_read.Store.list_sessions store))))

let test_rejects_intermediate_root_symlinks () =
  with_root (fun root ->
      let external_root = Filename.temp_file "mesh-read-external" "" in
      Sys.remove external_root;
      Unix.mkdir external_root 0o700;
      Fun.protect
        ~finally:(fun () -> Unix.rmdir external_root)
        (fun () ->
          let store = Mesh_read.Store.create (config root) in
          let claude_projects = Filename.concat external_root "projects" in
          Unix.mkdir claude_projects 0o700;
          Unix.symlink external_root (Filename.concat root ".claude");
          Alcotest.(check bool)
            "external Claude root is rejected" true
            (Result.is_error (Mesh_read.Store.list_sessions store));
          Alcotest.(check bool)
            "external Claude root cannot be read" true
            (Result.is_error
               (Mesh_read.Store.read_transcript store ~agent:"claude" ~id:sid));
          Unix.unlink (Filename.concat root ".claude");
          Unix.rmdir claude_projects;
          let codex_sessions = Filename.concat external_root "sessions" in
          Unix.mkdir codex_sessions 0o700;
          Unix.symlink external_root (Filename.concat root ".codex");
          Alcotest.(check bool)
            "external Codex root is rejected" true
            (Result.is_error (Mesh_read.Store.list_sessions store));
          Alcotest.(check bool)
            "external Codex root cannot be read" true
            (Result.is_error
               (Mesh_read.Store.read_transcript store ~agent:"codex"
                  ~id:codex_sid));
          Unix.unlink (Filename.concat root ".codex");
          Unix.rmdir codex_sessions))

let test_discovery_bound_fails_closed () =
  with_root (fun root ->
      let transcript = claude_fixture root in
      let directory = Filename.dirname transcript in
      for index = 1 to 512 do
        write
          (Filename.concat directory (Printf.sprintf "other-%03d.jsonl" index))
          []
      done;
      let store = Mesh_read.Store.create (config root) in
      Alcotest.(check bool)
        "directory overflow is an error, not a partial list" true
        (Result.is_error (Mesh_read.Store.list_sessions store));
      Alcotest.(check bool)
        "read also fails while discovery is over limit" true
        (Result.is_error
           (Mesh_read.Store.read_transcript store ~agent:"claude" ~id:sid)))

let test_fails_closed_for_malformed_and_bounded_content () =
  with_root (fun root ->
      let path = claude_fixture root in
      let store = Mesh_read.Store.create (config root) in
      append_raw path "{not-json}\n";
      Alcotest.(check bool)
        "malformed record returns no partial transcript" true
        (Result.is_error
           (Mesh_read.Store.read_transcript store ~agent:"claude" ~id:sid));
      let oversized = String.make ((32 * 1024) + 1) 'x' in
      write path
        [
          `Assoc
            [
              ("type", `String "user");
              ("message", `Assoc [ ("content", `String oversized) ]);
            ];
        ];
      Alcotest.(check bool)
        "oversized message is rejected" true
        (Result.is_error
           (Mesh_read.Store.read_transcript store ~agent:"claude" ~id:sid));
      let messages =
        List.init 1_001 (fun _ ->
            `Assoc
              [
                ("type", `String "user");
                ("message", `Assoc [ ("content", `String "small") ]);
              ])
      in
      write path messages;
      Alcotest.(check bool)
        "message cap is rejected rather than truncated" true
        (Result.is_error
           (Mesh_read.Store.read_transcript store ~agent:"claude" ~id:sid));
      write path [];
      append_raw path
        ("{\"type\":\"user\",\"message\":{\"content\":\""
        ^ String.make 1 (Char.chr 255)
        ^ "\"}}\n");
      Alcotest.(check bool)
        "invalid UTF-8 is rejected" true
        (Result.is_error
           (Mesh_read.Store.read_transcript store ~agent:"claude" ~id:sid)))

let test_mcp_declaration () =
  with_root (fun root ->
      let server = Mesh_read.server (config root) in
      let session = Mcp_kit.Server.create_session server in
      ignore
        (Mcp_kit_stdio.serve_session_line session
           {|{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}|});
      ignore
        (Mcp_kit_stdio.serve_session_line session
           {|{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}|});
      let response =
        Mcp_kit_stdio.serve_session_line session
          {|{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}|}
      in
      let names =
        match response with
        | Some text -> (
            match Yojson.Safe.from_string text with
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
        "closed tool set"
        [ "list_sessions"; "read_transcript" ]
        names)

let test_utf8_scalar_boundary agent label accepted content () =
  with_root (fun root ->
      let path, id, record =
        if agent = "claude" then
          ( claude_fixture root,
            sid,
            fun value ->
              `Assoc
                [
                  ("type", `String "user");
                  ("message", `Assoc [ ("content", `String value) ]);
                ] )
        else (
          codex_fixture root;
          ( Filename.concat root
              (".codex/sessions/2026/10/05/rollout-2026-10-05T10-00-00-"
             ^ codex_sid ^ ".jsonl"),
            codex_sid,
            fun value ->
              `Assoc
                [
                  ("type", `String "event_msg");
                  ( "payload",
                    `Assoc
                      [
                        ("type", `String "user_message");
                        ("message", `String value);
                      ] );
                ] ))
      in
      let store = Mesh_read.Store.create (config root) in
      let read () = Mesh_read.Store.read_transcript store ~agent ~id in
      let check_contents expected result =
        let (transcript : Mesh_read.transcript) = Result.get_ok result in
        Alcotest.(check (list string))
          label expected
          (List.map
             (fun (message : Mesh_read.message) -> message.content)
             transcript.messages)
      in
      write path [ record "valid prefix"; record content ];
      if accepted then check_contents [ "valid prefix"; content ] (read ())
      else (
        Alcotest.(check bool)
          (label ^ ": no partial transcript")
          true
          (Result.is_error (read ()));
        write path [ record "valid prefix"; record "é🙂" ];
        check_contents [ "valid prefix"; "é🙂" ] (read ())))

let utf8_scalar_boundary_cases =
  let valid =
    [
      ("ASCII", "plain text");
      ("NUL", "\x00");
      ("U007F", "\x7F");
      ("U0080", "\xC2\x80");
      ("U07FF", "\xDF\xBF");
      ("U0800", "\xE0\xA0\x80");
      ("U0FFF", "\xE0\xBF\xBF");
      ("UD7FF", "\xED\x9F\xBF");
      ("UE000", "\xEE\x80\x80");
      ("UFFFF", "\xEF\xBF\xBF");
      ("U10000", "\xF0\x90\x80\x80");
      ("U10FFFF", "\xF4\x8F\xBF\xBF");
      ("mixed", "ASCII é 🙂");
    ]
  in
  let invalid =
    [
      ("E0 noncontinuation FF", "\xE0\xFF\x80");
      ("E0 noncontinuation C0", "\xE0\xC0\x80");
      ("ED noncontinuation 00", "\xED\x00\x80");
      ("ED noncontinuation 7F", "\xED\x7F\x80");
      ("F0 noncontinuation FF", "\xF0\xFF\x80\x80");
      ("F4 noncontinuation 00", "\xF4\x00\x80\x80");
      ("F4 noncontinuation 7F", "\xF4\x7F\x80\x80");
      ("overlong two", "\xC0\x80");
      ("overlong three", "\xE0\x9F\x80");
      ("overlong four", "\xF0\x8F\xBF\xBF");
      ("surrogate", "\xED\xA0\x80");
      ("above Unicode maximum", "\xF4\x90\x80\x80");
      ("bad final continuation", "\xE1\x80\xFF");
      ("lone continuation", "\x80");
      ("truncated two", "\xC2");
      ("truncated three", "\xE0\xA0");
      ("truncated four", "\xF0\x90\x80");
      ("invalid lead", "\xF5\x80\x80\x80");
    ]
  in
  List.concat_map
    (fun agent ->
      List.map
        (fun (accepted, (label, content)) ->
          Alcotest.test_case
            (agent ^ ": " ^ label)
            `Quick
            (test_utf8_scalar_boundary agent label accepted content))
        (List.map (fun case -> (true, case)) valid
        @ List.map (fun case -> (false, case)) invalid))
    [ "claude"; "codex" ]

let () =
  Alcotest.run "mesh-read"
    [
      ( "store",
        [
          Alcotest.test_case "lists and reads synthetic transcript roots" `Quick
            test_list_and_read;
          Alcotest.test_case "rejects arbitrary path selection" `Quick
            test_rejects_unbounded_selection;
          Alcotest.test_case "rejects intermediate root symlinks" `Quick
            test_rejects_intermediate_root_symlinks;
          Alcotest.test_case "fails closed on discovery overflow" `Quick
            test_discovery_bound_fails_closed;
          Alcotest.test_case "fails closed for malformed or bounded content"
            `Quick test_fails_closed_for_malformed_and_bounded_content;
        ] );
      ( "mcp",
        [
          Alcotest.test_case "declares only read tools" `Quick
            test_mcp_declaration;
        ] );
      ("utf8 scalar boundaries", utf8_scalar_boundary_cases);
    ]
