(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* `mesh-platform accounts carry`, as the web server runs it: the JSON it
   prints and its exit status, the default account found through HOME. *)

let exe = "../../platform/cli/mesh_platform_main.exe"
let sid = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"

let rec remove path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Array.iter (fun name -> remove (Filename.concat path name)) (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let rec mkdirs path =
  if not (Sys.file_exists path) then begin
    mkdirs (Filename.dirname path);
    Unix.mkdir path 0o700
  end

let write path text =
  mkdirs (Filename.dirname path);
  Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_trunc ] 0o600 path
    (fun channel -> Out_channel.output_string channel text)

let read_all descriptor =
  let buffer = Buffer.create 256 and chunk = Bytes.create 4096 in
  let rec loop () =
    match Unix.read descriptor chunk 0 4096 with
    | 0 -> Unix.close descriptor
    | n ->
        Buffer.add_subbytes buffer chunk 0 n;
        loop ()
  in
  loop ();
  Buffer.contents buffer

(* Only HOME and PATH: no CLAUDE_CONFIG_DIR or CODEX_HOME of the test runner. *)
let run home args =
  let out_read, out_write = Unix.pipe ~cloexec:true () in
  let child =
    Unix.create_process_env exe
      (Array.of_list (exe :: args))
      [| "HOME=" ^ home; "PATH=/usr/bin:/bin" |]
      Unix.stdin out_write Unix.stderr
  in
  Unix.close out_write;
  let text = read_all out_read in
  let _, status = Unix.waitpid [] child in
  (status, Yojson.Safe.from_string text)

let field name = function
  | `Assoc fields -> List.assoc_opt name fields
  | _ -> None

let test_carry_from_default_to_alias () =
  let root = Filename.temp_dir "carrycli" "" in
  Fun.protect
    ~finally:(fun () -> remove root)
    (fun () ->
      let work = Filename.concat root "accounts/work/.claude" in
      mkdirs (Filename.dirname work);
      let file = Filename.concat root "accounts.json" in
      write file
        (Printf.sprintf
           {|{"v": 1, "accounts": [{"id": "work", "label": "Work", "claude_config_dir": "%s"}]}|}
           work);
      let transcript = "projects/-home-me/" ^ sid ^ ".jsonl" in
      write (Filename.concat root (".claude/" ^ transcript)) "{\"line\":1}\n";
      write (Filename.concat root ".claude/.credentials.json") "{\"secret\":1}";
      let status, answer =
        run root [ "accounts"; "carry"; file; "claude"; sid; "default"; "work" ]
      in
      Alcotest.(check bool) "exit 0" true (status = Unix.WEXITED 0);
      Alcotest.(check (option int))
        "one file copied" (Some 1)
        (match Option.bind (field "carried" answer) (field "copied") with
        | Some (`Int n) -> Some n
        | _ -> None);
      Alcotest.(check bool)
        "the alias folder was created and holds the conversation" true
        (Sys.file_exists (Filename.concat work transcript));
      Alcotest.(check bool)
        "no login file" false
        (Sys.file_exists (Filename.concat work ".credentials.json"));
      List.iter
        (fun (args, code) ->
          let status, answer = run root ([ "accounts"; "carry"; file ] @ args) in
          Alcotest.(check bool) (code ^ ": exit 1") true (status = Unix.WEXITED 1);
          Alcotest.(check (option string))
            code (Some code)
            (match field "code" answer with Some (`String c) -> Some c | _ -> None))
        [
          ([ "claude"; sid; "default"; "nobody" ], "account_unknown");
          ([ "codex"; sid; "default"; "work" ], "account_no_agent");
          ([ "claude"; "../" ^ sid; "default"; "work" ], "conversation_unknown");
          ([ "gemini"; sid; "default"; "work" ], "agent_unsupported");
          ([ "claude"; sid; "work"; "work" ], "account_same");
          ([ "claude"; "1f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"; "default"; "work" ],
            "conversation_not_found");
        ])

let () =
  Alcotest.run "mesh-platform-accounts-carry"
    [
      ( "cli",
        [
          Alcotest.test_case "carry from the default account to an alias" `Quick
            test_carry_from_default_to_alias;
        ] );
    ]
