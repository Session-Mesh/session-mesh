(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

open Mesh_conversation_store

let with_registry f =
  let root = Filename.temp_file "conversation-store-" "" in
  Sys.remove root;
  Unix.mkdir root 0o700;
  Fun.protect ~finally:(fun () ->
      Array.iter (fun name ->
          let path = Filename.concat root name in
          if Sys.is_directory path then Unix.rmdir path else Sys.remove path)
        (Sys.readdir root);
      Unix.rmdir root)
    (fun () -> f (Filename.concat root "conversation-names.json")
        (Filename.concat root "conversation-names.lock"))

let expect_contents expected path =
  transact ~path (fun source ->
      (match source with
       | Contents data -> Alcotest.(check string) "contents" expected data
       | Missing | Unreadable _ -> Alcotest.fail "expected readable registry");
      (), None)

let persistence () =
  with_registry (fun path _ ->
      transact ~path (fun source ->
          (match source with Missing -> () | _ -> Alcotest.fail "expected missing registry");
          (), None);
      Alcotest.(check bool) "unchanged missing registry" false (Sys.file_exists path);
      transact ~path (fun _ -> (), Some "old\000bytes");
      let original = Unix.stat path in
      Alcotest.(check int) "private file" 0o600 original.st_perm;
      expect_contents "old\000bytes" path;
      Alcotest.(check int) "read leaves inode unchanged" original.st_ino (Unix.stat path).st_ino;
      let reader = open_in_bin path in
      Fun.protect ~finally:(fun () -> close_in reader) (fun () ->
          transact ~path (fun _ -> (), Some "new bytes");
          Alcotest.(check string) "open reader still sees old bytes" "old\000bytes"
            (really_input_string reader 9));
      expect_contents "new bytes" path)

let failure () =
  with_registry (fun path _ ->
      Unix.mkdir path 0o700;
      let calls = ref 0 in
      (match transact ~path (fun source ->
           incr calls;
           (match source with
            | Unreadable Unix.EISDIR -> ()
            | _ -> Alcotest.fail "expected a read error");
           (), Some "cannot replace directory") with
       | () -> Alcotest.fail "expected rename failure"
       | exception Unix.Unix_error _ -> ());
      Alcotest.(check int) "callback ran once" 1 !calls;
      Alcotest.(check int) "failed write cleaned temporary file" 2
        (Array.length (Sys.readdir (Filename.dirname path)));
      Unix.rmdir path;
      (match transact ~path (fun _ -> raise Exit) with
       | exception Exit -> ()
       | _ -> Alcotest.fail "expected callback exception");
      transact ~path (fun _ -> (), Some "after failure");
      expect_contents "after failure" path)

external flock_try : Unix.file_descr -> bool = "mesh_worklog_flock_try"

let receive_signal fd =
  let ready, _, _ = Unix.select [fd] [] [] 5. in
  if ready = [] then Alcotest.fail "timed out waiting for native process";
  let byte = Bytes.create 1 in
  if Unix.read fd byte 0 1 = 0 then Alcotest.fail "native process closed signal pipe";
  Bytes.get byte 0

(* The peer opens the sidecar independently and calls flock directly, without
   the transaction wrapper. The pipes signal its attempt and control release. *)
let with_peer_lock ~hold lock f =
  let status_read, status_write = Unix.pipe ~cloexec:true () in
  let release_read, release_write = Unix.pipe ~cloexec:true () in
  match Unix.fork () with
  | 0 ->
      Unix.close status_read;
      Unix.close release_write;
      let code =
        try
          let fd = Unix.openfile lock [Unix.O_WRONLY; Unix.O_CREAT; Unix.O_APPEND] 0o666 in
          let acquired = flock_try fd in
          let status = if acquired then "a" else "b" in
          ignore (Unix.write_substring status_write status 0 1);
          if hold && acquired then ignore (Unix.read release_read (Bytes.create 1) 0 1);
          Unix.close fd;
          0
        with _ -> 1
      in
      Unix._exit code
  | child ->
      Unix.close status_write;
      Unix.close release_read;
      let release = Unix.out_channel_of_descr release_write in
      Fun.protect ~finally:(fun () ->
          close_out_noerr release;
          Unix.close status_read;
          let _, status = Unix.waitpid [] child in
          Alcotest.(check bool) "peer exited successfully" true (status = Unix.WEXITED 0))
        (fun () -> f (receive_signal status_read) release)

let post_commit () =
  with_registry (fun path lock ->
      let mutations = ref 0 in
      let results = ref 0 in
      let after_write () =
        incr results;
        with_peer_lock ~hold:false lock (fun status _ ->
            Alcotest.(check char) "result runs under lock" 'b' status);
        let input = open_in_bin path in
        Fun.protect ~finally:(fun () -> close_in input)
          (fun () -> really_input_string input 5)
      in
      let prepare _ =
        incr mutations;
        after_write, Some "saved"
      in
      Unix.mkdir path 0o700;
      (match transact_then ~path prepare with
       | _ -> Alcotest.fail "expected rename failure"
       | exception Unix.Unix_error _ -> ());
      Alcotest.(check int) "failed mutation ran once" 1 !mutations;
      Alcotest.(check int) "result skipped after write failure" 0 !results;
      Unix.rmdir path;
      let saved = transact_then ~path prepare in
      Alcotest.(check string) "result reads committed file" "saved" saved;
      Alcotest.(check int) "result ran once" 1 !results)

let interoperability () =
  with_registry (fun path lock ->
      transact ~path (fun _ ->
          with_peer_lock ~hold:false lock (fun status _ ->
              Alcotest.(check char) "peer excluded by transaction lock" 'b' status);
          (), None);
      with_peer_lock ~hold:false lock (fun status _ ->
          Alcotest.(check char) "peer enters after transaction releases lock" 'a' status);
      with_peer_lock ~hold:true lock (fun status release ->
          Alcotest.(check char) "peer acquired lock" 'a' status;
          let read_signal, write_signal = Unix.pipe ~cloexec:true () in
          match Unix.fork () with
          | 0 ->
              Unix.close read_signal;
              close_out_noerr release;
              let code =
                try
                  let send value = ignore (Unix.write_substring write_signal value 0 1) in
                  send "s";
                  transact ~path (fun _ -> send "e"; (), None);
                  0
                with _ -> 1
              in
              Unix._exit code
          | child ->
              Unix.close write_signal;
              Fun.protect ~finally:(fun () ->
                  close_out_noerr release;
                  Unix.close read_signal;
                  let _, status = Unix.waitpid [] child in
                  Alcotest.(check bool) "native process exited successfully" true
                    (status = Unix.WEXITED 0)) (fun () ->
                  Alcotest.(check char) "native process began" 's' (receive_signal read_signal);
                  let ready, _, _ = Unix.select [read_signal] [] [] 0.15 in
                  Alcotest.(check bool) "transaction waits for peer" true (ready = []);
                  output_char release '\n';
                  flush release;
                  Alcotest.(check char) "transaction enters after peer releases lock" 'e'
                    (receive_signal read_signal))))

let helper = Sys.argv.(1)

let parent_guard ~kill_parent () =
  with_registry (fun path lock ->
      transact ~path (fun _ -> (), Some "[]\n");
      let dir = Filename.dirname path in
      let frame_path = Filename.concat dir "frame" in
      Out_channel.with_open_bin frame_path (fun out ->
          output_string out
            {|{"version":1,"op":"rename","name":"audit","created":1,"now":100,"old":"","new":"Review"}|};
          output_char out '\n');
      with_peer_lock ~hold:true lock (fun status release ->
          Alcotest.(check char) "peer holds the lock" 'a' status;
          let response_read, response_write = Unix.pipe ~cloexec:true () in
          let pid_read, pid_write = Unix.pipe ~cloexec:true () in
          match Unix.fork () with
          | 0 ->
              Unix.close response_read;
              Unix.close pid_read;
              close_out_noerr release;
              let code =
                try
                  let frame = Unix.openfile frame_path [Unix.O_RDONLY; Unix.O_CLOEXEC] 0 in
                  let helper_pid =
                    Fun.protect ~finally:(fun () -> Unix.close frame) (fun () ->
                        Unix.create_process_env helper [|helper; "--conversation-names"|]
                          [|"MESH_CONF_DIR=" ^ dir;
                            "MESH_CONVERSATION_PARENT_PID=" ^ string_of_int (Unix.getpid ())|]
                          frame response_write Unix.stderr)
                  in
                  Unix.close response_write;
                  let pids = Unix.out_channel_of_descr pid_write in
                  Printf.fprintf pids "%d\n" helper_pid;
                  close_out pids;
                  match snd (Unix.waitpid [] helper_pid) with
                  | Unix.WEXITED code -> code
                  | _ -> 1
                with _ -> 1
              in
              Unix._exit code
          | parent ->
              Unix.close response_write;
              Unix.close pid_write;
              let response = Unix.in_channel_of_descr response_read in
              let reaped = ref false in
              let helper_pid = ref None in
              let kill pid =
                try Unix.kill pid Sys.sigkill with Unix.Unix_error (Unix.ESRCH, _, _) -> ()
              in
              let reap () =
                let _, status = Unix.waitpid [] parent in
                reaped := true;
                status
              in
              Fun.protect ~finally:(fun () ->
                  close_in_noerr response;
                  if not !reaped then (
                    kill parent;
                    ignore (reap ()));
                  Option.iter kill !helper_pid)
                (fun () ->
                  let pids = Unix.in_channel_of_descr pid_read in
                  let pid =
                    Fun.protect ~finally:(fun () -> close_in_noerr pids) (fun () ->
                        int_of_string (input_line pids))
                  in
                  helper_pid := Some pid;
                  let ready, _, _ = Unix.select [response_read] [] [] 0.15 in
                  Alcotest.(check bool) "helper waits for peer" true (ready = []);
                  if kill_parent then (
                    kill parent;
                    Alcotest.(check bool) "parent died by signal" true
                      (reap () = Unix.WSIGNALED Sys.sigkill);
                    let ready, _, _ = Unix.select [response_read] [] [] 5. in
                    Alcotest.(check bool) "helper exits before lock release" true (ready <> []);
                    Alcotest.(check int) "orphan has no response" 0
                      (Unix.read response_read (Bytes.create 1) 0 1);
                    helper_pid := None;
                    Alcotest.(check string) "registry unchanged" "[]\n"
                      (In_channel.with_open_bin path In_channel.input_all))
                  else (
                    output_char release '\n';
                    flush release;
                    let ready, _, _ = Unix.select [response_read] [] [] 5. in
                    Alcotest.(check bool) "helper responds after lock release" true (ready <> []);
                    Alcotest.(check string) "normal helper response" {|{"version":1,"result":null}|}
                      (input_line response);
                    Alcotest.(check bool) "helper succeeded" true (reap () = Unix.WEXITED 0);
                    helper_pid := None;
                    Alcotest.(check bool) "registry write committed" true
                      (In_channel.with_open_bin path In_channel.input_all <> "[]\n")))))

let () =
  (* Dune passes the executable that will serve real registry requests. *)
  let argv = Array.init (Array.length Sys.argv - 1)
      (fun index -> Sys.argv.(if index = 0 then 0 else index + 1)) in
  Alcotest.run ~argv "conversation store" [
    "transaction", [
      Alcotest.test_case "atomic persistence" `Quick persistence;
      Alcotest.test_case "failure and release" `Quick failure;
      Alcotest.test_case "post-commit result" `Quick post_commit;
      Alcotest.test_case "BSD flock interoperability" `Quick interoperability;
      Alcotest.test_case "helper exits when its parent dies while waiting" `Quick
        (parent_guard ~kill_parent:true);
      Alcotest.test_case "helper waits and commits while its parent lives" `Quick
        (parent_guard ~kill_parent:false);
    ];
  ]
