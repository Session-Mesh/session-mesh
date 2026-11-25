(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let host = Sys.argv.(1)
let plugin = Sys.argv.(2)
let mesh_plugin = Sys.argv.(3)

let run ?plugin_path ?journal () =
  let input = Filename.temp_file "mesh-trace-input-" ".jsonl" in
  let output = Filename.temp_file "mesh-trace-events-" ".txt" in
  let errors = Filename.temp_file "mesh-trace-errors-" ".txt" in
  let channel = open_out input in
  output_string channel
    {|{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whiteboard","arguments":{"action":"describe"}}}
{"jsonrpc":"2.0","id":3,"method":"untrusted-client-content"}
|};
  close_out channel;
  let descriptor = Unix.openfile input [ Unix.O_RDONLY ] 0 in
  let null = Unix.openfile "/dev/null" [ Unix.O_WRONLY ] 0 in
  let stderr = Unix.openfile errors [ Unix.O_WRONLY; Unix.O_TRUNC ] 0 in
  let environment =
    [ "MESH_SESSION_TOKEN=test"; "MESH_TEST_TRACE_OUTPUT=" ^ output ]
    @ (match plugin_path with
      | None -> []
      | Some value -> [ "MESH_MCP_TRACE_PLUGIN=" ^ value ])
    @
    match journal with
    | None -> []
    | Some value -> [ "MESH_MCP_TRACE_JOURNAL=" ^ value ]
  in
  let pid =
    Unix.create_process_env host [| host |]
      (Array.of_list environment)
      descriptor null stderr
  in
  List.iter Unix.close [ descriptor; null; stderr ];
  let _, status = Unix.waitpid [] pid in
  let events = In_channel.with_open_text output In_channel.input_all in
  let diagnostics = In_channel.with_open_text errors In_channel.input_all in
  List.iter Sys.remove [ input; output; errors ];
  Alcotest.(check bool)
    "the MCP host exits successfully" true (status = Unix.WEXITED 0);
  (events, diagnostics)

let test_default () =
  let events, diagnostics = run () in
  Alcotest.(check string) "disabled by default" "" events;
  Alcotest.(check string) "no diagnostics" "" diagnostics

let test_plugin () =
  let events, diagnostics = run ~plugin_path:plugin () in
  let lines = String.split_on_char '\n' events in
  Alcotest.(check bool)
    "tool call started" true
    (List.mem "started tools/call" lines);
  Alcotest.(check bool)
    "tool call finished" true
    (List.mem "finished tools/call" lines);
  Alcotest.(check string) "no diagnostics" "" diagnostics

let test_plugin_precedes_builtin () =
  let journal = Filename.temp_file "mesh-trace-plugin-precedence-" ".jsonl" in
  let events, diagnostics = run ~plugin_path:plugin ~journal () in
  let journal_content = In_channel.with_open_text journal In_channel.input_all in
  Sys.remove journal;
  Alcotest.(check bool) "plugin observes calls" true (String.length events > 0);
  Alcotest.(check string) "built-in journal is not used" "" journal_content;
  Alcotest.(check string) "no diagnostics" "" diagnostics

let test_missing_plugin () =
  let events, diagnostics = run ~plugin_path:(plugin ^ ".missing") () in
  Alcotest.(check string) "no observer" "" events;
  Alcotest.(check bool)
    "diagnostic reports failure" true
    (String.length diagnostics > 0)

let test_mesh_journal () =
  let path = Filename.temp_file "mesh-trace-journal-" ".jsonl" in
  let events, diagnostics = run ~plugin_path:mesh_plugin ~journal:path () in
  let content = In_channel.with_open_text path In_channel.input_all in
  Sys.remove path;
  let lines = String.split_on_char '\n' content |> List.filter (( <> ) "") in
  let json = List.map Yojson.Safe.from_string lines in
  let find_tool phase =
    List.find_opt
      (fun event ->
        let open Yojson.Safe.Util in
        member "method" event = `String "tools/call"
        && member "phase" event = `String phase)
      json
  in
  Alcotest.(check bool)
    "unknown method name is not recorded" true
    (List.exists
       (fun event -> Yojson.Safe.Util.member "method" event = `String "other")
       json);
  let started = Option.get (find_tool "started")
  and finished = Option.get (find_tool "finished") in
  let open Yojson.Safe.Util in
  Alcotest.(check string)
    "board server distinguished" "mesh-board-mcp"
    (member "server" started |> to_string);
  Alcotest.(check bool)
    "paired call id" true
    (member "call" started = member "call" finished);
  Alcotest.(check bool)
    "same process instance" true
    (member "instance" started = member "instance" finished);
  Alcotest.(check string)
    "tool" "whiteboard"
    (member "tool" started |> to_string);
  Alcotest.(check string)
    "action" "describe"
    (member "action" started |> to_string);
  Alcotest.(check bool)
    "token not present" false
    (String.equal (member "session" started |> to_string) "test");
  Alcotest.(check string) "no fixture trace" "" events;
  Alcotest.(check string) "no diagnostic" "" diagnostics

let test_concurrent_writers () =
  let path = Filename.temp_file "mesh-trace-concurrent-" ".jsonl" in
  match Unix.fork () with
  | 0 ->
      ignore (run ~plugin_path:mesh_plugin ~journal:path ());
      exit 0
  | child ->
      ignore (run ~plugin_path:mesh_plugin ~journal:path ());
      let _, status = Unix.waitpid [] child in
      let contents = In_channel.with_open_text path In_channel.input_all in
      Sys.remove path;
      Alcotest.(check bool)
        "both processes completed" true (status = Unix.WEXITED 0);
      let lines =
        String.split_on_char '\n' contents |> List.filter (( <> ) "")
      in
      let events = List.map Yojson.Safe.from_string lines in
      let instances =
        List.map (fun event -> Yojson.Safe.Util.member "instance" event) events
        |> List.sort_uniq compare
      in
      Alcotest.(check int) "two distinct writers" 2 (List.length instances);
      Alcotest.(check int) "all request events recorded" 12 (List.length events)

let test_built_in_journal () =
  let path = Filename.temp_file "mesh-trace-built-in-" ".jsonl" in
  let _, diagnostics = run ~journal:path () in
  let content = In_channel.with_open_text path In_channel.input_all in
  Sys.remove path;
  Alcotest.(check bool)
    "built-in observer records calls" true
    (String.length content > 0);
  Alcotest.(check string) "no diagnostic" "" diagnostics

let test_mesh_without_journal () =
  let events, diagnostics = run ~plugin_path:mesh_plugin () in
  Alcotest.(check string) "no storage configured" "" events;
  Alcotest.(check string) "no diagnostic" "" diagnostics

let test_private_journal () =
  let path = Filename.temp_file "mesh-trace-public-" ".jsonl" in
  Unix.chmod path 0o644;
  let _, diagnostics = run ~plugin_path:mesh_plugin ~journal:path () in
  let content = In_channel.with_open_text path In_channel.input_all in
  Sys.remove path;
  Alcotest.(check string) "unsafe journal left untouched" "" content;
  Alcotest.(check bool)
    "write failure reported" true
    (String.length diagnostics > 0)

let test_locked_journal () =
  let path = Filename.temp_file "mesh-trace-locked-" ".jsonl" in
  let fd = Unix.openfile path [ Unix.O_RDWR ] 0 in
  Unix.lockf fd Unix.F_LOCK 0;
  let child =
    match Unix.fork () with
    | 0 ->
        let _, diagnostics = run ~journal:path () in
        exit (if diagnostics = "" then 1 else 0)
    | pid -> pid
  in
  let rec wait attempts =
    match Unix.waitpid [ Unix.WNOHANG ] child with
    | 0, _ when attempts > 0 ->
        ignore (Unix.select [] [] [] 0.05);
        wait (attempts - 1)
    | 0, _ ->
        Unix.kill child Sys.sigkill;
        ignore (Unix.waitpid [] child);
        false
    | _, status -> status = Unix.WEXITED 0
  in
  let completed = wait 80 in
  Unix.lockf fd Unix.F_ULOCK 0;
  Unix.close fd;
  Sys.remove path;
  Alcotest.(check bool) "locked journal is reported without blocking MCP" true completed

let test_fifo_journal () =
  let path = Filename.temp_file "mesh-trace-fifo-" ".fifo" in
  Sys.remove path;
  Unix.mkfifo path 0o600;
  let _, diagnostics = run ~plugin_path:mesh_plugin ~journal:path () in
  Sys.remove path;
  Alcotest.(check bool)
    "FIFO refused without blocking" true
    (String.length diagnostics > 0)

let test_symlink_journal () =
  let target = Filename.temp_file "mesh-trace-target-" ".txt" in
  let path = target ^ ".link" in
  Unix.symlink target path;
  let _, diagnostics = run ~plugin_path:mesh_plugin ~journal:path () in
  let content = In_channel.with_open_text target In_channel.input_all in
  Sys.remove path;
  Sys.remove target;
  Alcotest.(check string) "target not modified" "" content;
  Alcotest.(check bool) "link refused" true (String.length diagnostics > 0)

let test_dangling_journal () =
  List.iter
    (fun plugin_path ->
      let target = Filename.temp_file "mesh-trace-dangling-" ".txt" in
      Sys.remove target;
      let path = target ^ ".link" in
      Unix.symlink target path;
      Fun.protect ~finally:(fun () -> Sys.remove path; if Sys.file_exists target then Sys.remove target)
        (fun () ->
          let _, diagnostics = run ?plugin_path ~journal:path () in
          Alcotest.(check bool) "dangling target never created" false (Sys.file_exists target);
          Alcotest.(check bool) "link refused" true (String.length diagnostics > 0)))
    [ None; Some mesh_plugin ]

let test_hardlink_journal () =
  let target = Filename.temp_file "mesh-trace-hard-target-" ".txt" in
  let path = target ^ ".link" in
  Unix.link target path;
  let _, diagnostics = run ~plugin_path:mesh_plugin ~journal:path () in
  let content = In_channel.with_open_text target In_channel.input_all in
  Sys.remove path;
  Sys.remove target;
  Alcotest.(check string) "target not modified" "" content;
  Alcotest.(check bool) "hard link refused" true (String.length diagnostics > 0)

let () =
  Alcotest.run
    ~argv:[| Sys.argv.(0) |]
    "board trace plugin"
    [
      ( "loading",
        [
          Alcotest.test_case "disabled by default" `Quick test_default;
          Alcotest.test_case "loads explicit plugin" `Quick test_plugin;
          Alcotest.test_case "plugin precedes built-in journal" `Quick
            test_plugin_precedes_builtin;
          Alcotest.test_case "missing plugin" `Quick test_missing_plugin;
          Alcotest.test_case "Mesh journal" `Quick test_mesh_journal;
          Alcotest.test_case "concurrent writers" `Quick test_concurrent_writers;
          Alcotest.test_case "built-in journal" `Quick test_built_in_journal;
          Alcotest.test_case "Mesh plugin without journal" `Quick
            test_mesh_without_journal;
          Alcotest.test_case "refuses non-private journal" `Quick
            test_private_journal;
          Alcotest.test_case "locked journal does not stall" `Quick
            test_locked_journal;
          Alcotest.test_case "refuses a FIFO" `Quick test_fifo_journal;
          Alcotest.test_case "refuses a symlink" `Quick test_symlink_journal;
          Alcotest.test_case "refuses a dangling symlink" `Quick test_dangling_journal;
          Alcotest.test_case "refuses a hard link" `Quick test_hardlink_journal;
        ] );
    ]
