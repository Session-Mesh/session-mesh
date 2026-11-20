(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Carrying one conversation from an account's folder to another's: only the
   conversation's own files, never a link, never a login file, never over a
   different copy, and nothing left behind when the copy fails. *)

module C = Mesh_accounts_carry

let uid = Unix.geteuid ()
let sid = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e"

let rec remove path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Array.iter
        (fun name -> remove (Filename.concat path name))
        (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let with_root f =
  let root = Filename.temp_dir "carry" "" in
  Fun.protect ~finally:(fun () -> remove root) (fun () -> f root)

let mkdirs path =
  let rec make path =
    if not (Sys.file_exists path) then begin
      make (Filename.dirname path);
      Unix.mkdir path 0o700
    end
  in
  make path

let write path text =
  mkdirs (Filename.dirname path);
  Out_channel.with_open_gen
    [ Open_wronly; Open_creat; Open_trunc; Open_binary ]
    0o600 path
    (fun channel -> Out_channel.output_string channel text)

let read path = In_channel.with_open_bin path In_channel.input_all
let exists path = match Unix.lstat path with _ -> true | exception _ -> false

(* Every path under [folder], relative, sorted: what a carry left there. *)
let listing folder =
  let rec walk relative acc =
    let path = if relative = "" then folder else Filename.concat folder relative in
    match Unix.lstat path with
    | { Unix.st_kind = Unix.S_DIR; _ } ->
        Array.fold_left
          (fun acc name ->
            let child =
              if relative = "" then name else Filename.concat relative name
            in
            walk child (child :: acc))
          acc (Sys.readdir path)
    | _ -> acc
    | exception Unix.Unix_error (Unix.ENOENT, _, _) -> acc
  in
  List.sort String.compare (walk "" [])

let project = "projects/-home-me-work"
let transcript = project ^ "/" ^ sid ^ ".jsonl"

(* A Claude account folder as Claude leaves it: login files at the top, the
   project's memory and other conversations next to this one. *)
let claude_account root name =
  let folder = Filename.concat root name in
  mkdirs folder;
  write (Filename.concat folder ".credentials.json") "{\"secret\":1}";
  write (Filename.concat folder ".claude.json") "{\"secret\":2}";
  write (Filename.concat folder "settings.json") "{}";
  folder

let with_conversation folder =
  write (Filename.concat folder transcript) "{\"line\":1}\n{\"line\":2}\n";
  write
    (Filename.concat folder (project ^ "/" ^ sid ^ "/subagents/agent-1.jsonl"))
    "{\"sub\":1}\n";
  write
    (Filename.concat folder (project ^ "/" ^ sid ^ "/tool-results/r1.txt"))
    "result";
  write (Filename.concat folder (project ^ "/other-conversation.jsonl")) "x";
  write (Filename.concat folder (project ^ "/memory/MEMORY.md")) "memory"

let carried = function
  | Ok outcome -> outcome
  | Error { C.code; message } -> Alcotest.failf "refused: %s %s" code message

let refused_with code = function
  | Ok _ -> Alcotest.failf "carried, expected %s" code
  | Error { C.code = found; message } ->
      Alcotest.(check string) ("code (" ^ message ^ ")") code found

let carry ?io ~source ~target kind =
  C.carry ?io ~uid ~kind ~conversation:sid ~source ~target ()

let test_claude_conversation () =
  with_root (fun root ->
      let source = claude_account root "a" in
      let target = claude_account root "b" in
      with_conversation source;
      let outcome = carried (carry ~source ~target C.Claude) in
      Alcotest.(check int) "three files" 3 outcome.C.files;
      Alcotest.(check (list string))
        "the conversation and its own folder only"
        [
          ".claude.json";
          ".credentials.json";
          "projects";
          project;
          project ^ "/" ^ sid;
          project ^ "/" ^ sid ^ ".jsonl";
          project ^ "/" ^ sid ^ "/subagents";
          project ^ "/" ^ sid ^ "/subagents/agent-1.jsonl";
          project ^ "/" ^ sid ^ "/tool-results";
          project ^ "/" ^ sid ^ "/tool-results/r1.txt";
          "settings.json";
        ]
        (listing target);
      Alcotest.(check string)
        "same content" (read (Filename.concat source transcript))
        (read (Filename.concat target transcript));
      Alcotest.(check string)
        "the target's own login is untouched" "{\"secret\":2}"
        (read (Filename.concat target ".claude.json"));
      Alcotest.(check int)
        "private" 0o600
        ((Unix.stat (Filename.concat target transcript)).Unix.st_perm land 0o777);
      Alcotest.(check int)
        "private folders" 0o700
        ((Unix.stat (Filename.concat target project)).Unix.st_perm land 0o777))

let rollout = "sessions/2026/11/20/rollout-2026-11-20T10-00-00-" ^ sid ^ ".jsonl"

let test_codex_rollout () =
  with_root (fun root ->
      let source = Filename.concat root "a" and target = Filename.concat root "b" in
      write (Filename.concat source "auth.json") "{\"secret\":1}";
      write (Filename.concat source "config.toml") "";
      write (Filename.concat source rollout) "{\"type\":\"session_meta\"}\n";
      write
        (Filename.concat source "sessions/2026/11/20/rollout-2026-11-20T09-00-00-other.jsonl")
        "x";
      mkdirs target;
      let outcome = carried (carry ~source ~target C.Codex) in
      Alcotest.(check int) "one file" 1 outcome.C.files;
      Alcotest.(check (list string))
        "the rollout at the same place, nothing else"
        [
          "sessions";
          "sessions/2026";
          "sessions/2026/11";
          "sessions/2026/11/20";
          rollout;
        ]
        (listing target))

let test_hostile_ids () =
  with_root (fun root ->
      let source = claude_account root "a" in
      let target = claude_account root "b" in
      with_conversation source;
      List.iter
        (fun conversation ->
          refused_with "conversation_unknown"
            (C.carry ~uid ~kind:C.Claude ~conversation ~source ~target ()))
        [ ""; "../a"; "*"; "-rf"; "a/b"; sid ^ ".jsonl"; String.make 80 'a' ];
      Alcotest.(check bool)
        "nothing written" false
        (exists (Filename.concat target "projects")))

let test_not_found_and_ambiguous () =
  with_root (fun root ->
      let source = claude_account root "a" in
      let target = claude_account root "b" in
      refused_with "conversation_not_found" (carry ~source ~target C.Claude);
      with_conversation source;
      write
        (Filename.concat source ("projects/-elsewhere/" ^ sid ^ ".jsonl"))
        "x";
      refused_with "conversation_ambiguous" (carry ~source ~target C.Claude))

let test_links_are_refused () =
  with_root (fun root ->
      let outside = Filename.concat root "outside" in
      write (Filename.concat outside "secret.jsonl") "outside";
      let cases =
        [
          (* the transcript itself *)
          (fun source ->
            mkdirs (Filename.concat source project);
            Unix.symlink
              (Filename.concat outside "secret.jsonl")
              (Filename.concat source transcript));
          (* a file of its folder *)
          (fun source ->
            with_conversation source;
            Unix.symlink
              (Filename.concat outside "secret.jsonl")
              (Filename.concat source (project ^ "/" ^ sid ^ "/tool-results/l")));
          (* a folder of its folder *)
          (fun source ->
            with_conversation source;
            Unix.symlink outside
              (Filename.concat source (project ^ "/" ^ sid ^ "/linked")));
        ]
      in
      List.iteri
        (fun index plant ->
          let source = claude_account root (Printf.sprintf "s%d" index) in
          let target = claude_account root (Printf.sprintf "t%d" index) in
          plant source;
          (match carry ~source ~target C.Claude with
          | Ok _ -> Alcotest.failf "case %d: a link was carried" index
          | Error { C.code; _ } ->
              Alcotest.(check bool)
                (Printf.sprintf "case %d refused (%s)" index code)
                true
                (List.mem code [ "unsafe_entry"; "conversation_not_found" ]));
          Alcotest.(check bool)
            "nothing written" false
            (exists (Filename.concat target "projects")))
        cases)

let test_target_links_are_refused () =
  with_root (fun root ->
      let outside = Filename.concat root "outside" in
      mkdirs outside;
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      Unix.symlink outside (Filename.concat target "projects");
      refused_with "unsafe_entry" (carry ~source ~target C.Claude);
      Alcotest.(check (list string)) "outside untouched" [] (listing outside);
      let target = claude_account root "c" in
      mkdirs (Filename.concat target project);
      Unix.symlink
        (Filename.concat outside "planted")
        (Filename.concat target transcript);
      refused_with "unsafe_entry" (carry ~source ~target C.Claude);
      Alcotest.(check (list string)) "no file through the link" [] (listing outside))

let test_login_files_are_never_carried () =
  with_root (fun root ->
      List.iter
        (fun name ->
          let source = claude_account root ("s" ^ name) in
          let target = claude_account root ("t" ^ name) in
          with_conversation source;
          write
            (Filename.concat source (project ^ "/" ^ sid ^ "/" ^ name))
            "{\"secret\":1}";
          refused_with "unsafe_entry" (carry ~source ~target C.Claude);
          Alcotest.(check bool)
            "nothing written" false
            (exists (Filename.concat target "projects")))
        [ ".credentials.json"; ".claude.json"; "auth.json" ])

let test_round_trip_and_divergence () =
  with_root (fun root ->
      let source = claude_account root "a" in
      let target = claude_account root "b" in
      with_conversation source;
      ignore (carried (carry ~source ~target C.Claude));
      (* the same files again: nothing to do *)
      let again = carried (carry ~source ~target C.Claude) in
      Alcotest.(check int) "unchanged" 3 again.C.unchanged;
      (* the conversation went on in the source: the older copy is a prefix *)
      let path = Filename.concat source transcript in
      write path (read path ^ "{\"line\":3}\n");
      let grown = carried (carry ~source ~target C.Claude) in
      Alcotest.(check int) "replaced" 1 grown.C.replaced;
      Alcotest.(check string)
        "the longer copy" (read path)
        (read (Filename.concat target transcript));
      (* the target went on separately: a different copy is never replaced *)
      let target_path = Filename.concat target transcript in
      write target_path "{\"line\":1}\n{\"other\":2}\n{\"other\":3}\n{\"x\":4}\n";
      let before = read target_path in
      refused_with "conversation_diverged" (carry ~source ~target C.Claude);
      Alcotest.(check string) "kept" before (read target_path))

(* A failure while writing (a full disk) or while putting files in place
   leaves the target as it was: no new file, no temporary file, a replaced
   copy back. *)
let failing_io ~writes ~renames =
  let write_count = ref 0 and rename_count = ref 0 in
  {
    C.write =
      (fun descriptor buffer offset length ->
        incr write_count;
        if !write_count > writes then
          raise (Unix.Unix_error (Unix.ENOSPC, "write", ""))
        else Unix.write descriptor buffer offset length);
    rename =
      (fun old_path new_path ->
        incr rename_count;
        if !rename_count > renames then
          raise (Unix.Unix_error (Unix.EIO, "rename", ""))
        else Unix.rename old_path new_path);
  }

let test_a_failed_copy_changes_nothing () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      List.iter
        (fun (label, io) ->
          let target = claude_account root ("t-" ^ label) in
          let before = listing target in
          refused_with "carry_failed" (carry ~io ~source ~target C.Claude);
          Alcotest.(check (list string)) (label ^ ": as before") before (listing target))
        [
          ("first-write", failing_io ~writes:0 ~renames:max_int);
          ("second-write", failing_io ~writes:1 ~renames:max_int);
          ("second-rename", failing_io ~writes:max_int ~renames:1);
        ];
      (* with an older copy in place, a failed replacement keeps it *)
      let target = claude_account root "older" in
      write (Filename.concat target transcript) "{\"line\":1}\n";
      let before = listing target in
      refused_with "carry_failed"
        (carry ~io:(failing_io ~writes:max_int ~renames:2) ~source ~target C.Claude);
      Alcotest.(check (list string)) "as before" before (listing target);
      Alcotest.(check string)
        "the older copy" "{\"line\":1}\n"
        (read (Filename.concat target transcript)))

let test_same_folder_is_refused () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      refused_with "account_same" (carry ~source ~target:source C.Claude))

(* The folders themselves pass the alias rules (no link, private). *)
let test_unchecked_folders_are_refused () =
  with_root (fun root ->
      let source = claude_account root "a" in
      with_conversation source;
      let target = claude_account root "b" in
      Unix.chmod target 0o777;
      refused_with "account_folder_refused" (carry ~source ~target C.Claude);
      Unix.chmod target 0o700;
      let linked = Filename.concat root "linked" in
      Unix.symlink target linked;
      refused_with "account_folder_refused" (carry ~source ~target:linked C.Claude))

(* Resolving the folders from accounts.json: an alias's own folder for the
   agent, "default" from the environment, refusals with their code. *)
let test_account_folders () =
  with_root (fun root ->
      let work = Filename.concat root "work-claude" in
      mkdirs work;
      let file = Filename.concat root "accounts.json" in
      write file
        (Printf.sprintf
           {|{"v": 1, "accounts": [{"id": "work", "label": "Work", "claude_config_dir": "%s"}]}|}
           work);
      let getenv = function "HOME" -> Some root | _ -> None in
      let folder account kind =
        C.account_folder ~uid ~getenv ~file ~kind ~create:false account
      in
      Alcotest.(check (result string string))
        "alias" (Ok work)
        (Result.map_error (fun e -> e.C.code) (folder "work" C.Claude));
      mkdirs (Filename.concat root ".claude");
      Alcotest.(check (result string string))
        "default" (Ok (Filename.concat root ".claude"))
        (Result.map_error (fun e -> e.C.code) (folder "default" C.Claude));
      Alcotest.(check (result string string))
        "no Codex folder" (Error "account_no_agent")
        (Result.map_error (fun e -> e.C.code) (folder "work" C.Codex));
      Alcotest.(check (result string string))
        "unknown" (Error "account_unknown")
        (Result.map_error (fun e -> e.C.code) (folder "nobody" C.Claude));
      Unix.chmod file 0o666;
      Alcotest.(check (result string string))
        "refused file" (Error "accounts_refused")
        (Result.map_error (fun e -> e.C.code) (folder "work" C.Claude)))

let () =
  Alcotest.run "mesh-accounts-carry"
    [
      ( "carry",
        [
          Alcotest.test_case "a Claude conversation and its folder" `Quick
            test_claude_conversation;
          Alcotest.test_case "a Codex rollout" `Quick test_codex_rollout;
          Alcotest.test_case "hostile conversation ids" `Quick test_hostile_ids;
          Alcotest.test_case "not found, ambiguous" `Quick
            test_not_found_and_ambiguous;
          Alcotest.test_case "links in the source" `Quick test_links_are_refused;
          Alcotest.test_case "links in the target" `Quick
            test_target_links_are_refused;
          Alcotest.test_case "login files are never carried" `Quick
            test_login_files_are_never_carried;
          Alcotest.test_case "round trip and divergence" `Quick
            test_round_trip_and_divergence;
          Alcotest.test_case "a failed copy changes nothing" `Quick
            test_a_failed_copy_changes_nothing;
          Alcotest.test_case "same folder" `Quick test_same_folder_is_refused;
          Alcotest.test_case "unchecked folders" `Quick
            test_unchecked_folders_are_refused;
          Alcotest.test_case "account folders" `Quick test_account_folders;
        ] );
    ]
