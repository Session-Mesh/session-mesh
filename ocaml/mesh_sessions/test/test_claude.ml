(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The Claude adapter: its caches give the rows of a cold read, an unchanged
   transcript is not decoded again, and hostile files (huge or deep lines,
   invalid UTF-8, links, FIFOs, unreadable files, concurrent appends) neither
   stop it nor block it. *)

let pid = 4242
let id = "0b1e7a52-3f0e-4c55-9a8e-1f9d1f6b0b01"
let metadata = `Assoc [ ("sessionId", `String id); ("status", `String "idle") ]
let transcript_path home = String.concat "/" [ home; ".claude/projects/-work"; id ^ ".jsonl" ]
let fixture name = In_channel.with_open_bin (Filename.concat "fixtures/claude" name) In_channel.input_all
let sample = fixture "plain.jsonl" ^ fixture "asking.jsonl" ^ fixture "said.jsonl"

(* Describe the session as a round would: prepare, then describe. *)
let describe adapter =
  let round = Fake.round [ Fake.process ~pid ~sid:pid "claude" ] in
  Mesh_agent_claude.prepare adapter round;
  Mesh_agent_claude.describe adapter round (Fake.session pid) (Option.get (Mesh_agent_round.find round pid))

let fresh home = Mesh_agent_claude.create (Mesh_agent_roots.of_home home)
let cold home = describe (fresh home)

let fields = Alcotest.testable (fun format value -> Format.pp_print_string format (Yojson.Safe.to_string (`Assoc value))) ( = )
let field key fields = Option.value ~default:`Null (List.assoc_opt key fields)

let with_home f =
  Support.with_directory (fun home ->
      Fake.claude_home ~home ~pid ~metadata ~transcript:"" ();
      f home)

let test_cache_equals_cold () =
  Support.qcheck ~count:60 ~name:"pieces then cold" QCheck.(list_size Gen.(1 -- 6) (int_bound (String.length sample)))
    (fun cuts ->
      with_home (fun home ->
          let adapter = fresh home in
          let cuts = List.sort_uniq compare (0 :: String.length sample :: cuts) in
          let rec feed = function
            | a :: (b :: _ as rest) ->
                Support.append_file (transcript_path home) (String.sub sample a (b - a));
                ignore (describe adapter);
                feed rest
            | _ -> ()
          in
          feed cuts;
          describe adapter = cold home))

let test_no_decoding_when_unchanged () =
  with_home (fun home ->
      Support.write_file (transcript_path home) sample;
      let adapter = fresh home in
      let first = describe adapter in
      let before = Mesh_agent_claude.counters adapter in
      let second = describe adapter in
      let after = Mesh_agent_claude.counters adapter in
      Alcotest.check fields "same rows" first second;
      Alcotest.(check (pair int int)) "nothing decoded" (before.restarted, before.appended) (after.restarted, after.appended);
      Alcotest.(check int) "answered from the cache" (before.unchanged + 1) after.unchanged;
      Support.append_file (transcript_path home) (fixture "two-tools.jsonl");
      ignore (describe adapter);
      Alcotest.(check int) "appended bytes only" (after.appended + 1) (Mesh_agent_claude.counters adapter).appended;
      Support.write_file (transcript_path home) (fixture "titles.jsonl");
      Alcotest.check fields "rewrite read again" (cold home) (describe adapter))

let prompt text = Printf.sprintf {|{"type":"user","message":{"role":"user","content":"%s"}}|} text ^ "\n"

(* A 100 MB line (a hole: nothing is written) then an answer: the next
   description already reports the answer. *)
let test_large_append () =
  with_home (fun home ->
      let path = transcript_path home in
      Support.write_file path (prompt "before");
      let adapter = fresh home in
      ignore (describe adapter);
      let descriptor = Unix.openfile path [ Unix.O_WRONLY ] 0 in
      Fun.protect ~finally:(fun () -> Unix.close descriptor) (fun () ->
          Unix.ftruncate descriptor ((Unix.fstat descriptor).st_size + 100_000_000));
      Support.append_file path ("\n" ^ prompt "after the 100 MB line");
      Alcotest.(check bool) "up to date at once" true (field "last" (describe adapter) = `String "after the 100 MB line"))

let title text = Printf.sprintf {|{"type":"custom-title","customTitle":"%s"}|} text ^ "\n"

let answer ?(message = "m1") text =
  Printf.sprintf {|{"type":"assistant","message":{"id":"%s","content":[{"type":"text","text":"%s"}]}}|} message text ^ "\n"

(* 2 MB of lines that change no field, more than the 1.5 MB window. *)
let filler =
  String.concat ""
    (List.init 200 (fun n -> Printf.sprintf {|{"type":"progress","n":%d,"data":"%s"}|} n (String.make 10_000 'z') ^ "\n"))

let transcript_keys = [ "title"; "last"; "said"; "choices"; "ask_id" ]
let transcript_view described = List.map (fun key -> (key, field key described)) transcript_keys

(* State changes then more than a window of other lines: the description is
   the window's, as a first read (and Python, which reads only the window)
   gives, never the state from before the skipped lines. *)
let test_skip_restarts_the_fold () =
  with_home (fun home ->
      let path = transcript_path home in
      let adapter = fresh home in
      Support.write_file path (title "T1" ^ prompt "prompt one" ^ answer "answer one");
      Alcotest.(check bool) "12a: base" true (field "title" (describe adapter) = `String "T1");
      Support.append_file path (title "T2" ^ prompt "prompt two" ^ answer ~message:"m2" "answer two" ^ filler);
      let skipped = describe adapter in
      Alcotest.check fields "12b: the window's fields" (transcript_view (cold home)) (transcript_view skipped);
      Alcotest.(check bool) "12b: no title, prompt or answer from before the skip" true
        (List.for_all (fun key -> field key skipped = `Null) [ "title"; "last"; "said" ]))

let ask_question =
  {|{"type":"assistant","message":{"id":"mq","content":[{"type":"tool_use","id":"toolu_q","name":"AskUserQuestion",|}
  ^ {|"input":{"questions":[{"question":"Pick?","multiSelect":false,"options":[{"label":"Yes"},{"label":"No"}]}]}}]}}|}
  ^ "\n"

let question_answered =
  {|{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_q","content":"Yes"}]}}|}
  ^ "\n"

let test_skip_drops_an_answered_question () =
  with_home (fun home ->
      let path = transcript_path home in
      let adapter = fresh home in
      Support.write_file path (title "Q" ^ prompt "ask me" ^ ask_question);
      Alcotest.(check bool) "12c: pending question" true (field "ask_id" (describe adapter) = `String "toolu_q");
      Support.append_file path (question_answered ^ filler);
      let skipped = describe adapter in
      Alcotest.check fields "12d: the window's fields" (transcript_view (cold home)) (transcript_view skipped);
      Alcotest.(check bool) "12d: no choices of the answered question" true
        (field "choices" skipped = `Null && field "ask_id" skipped = `Null && field "said" skipped = `Null);
      Alcotest.check fields "12e: the next read" (transcript_view skipped) (transcript_view (describe adapter)))

let test_hostile_lines () =
  with_home (fun home ->
      let huge = {|{"type":"user","message":{"content":"|} ^ String.make 2_000_000 'x' ^ "\"}}\n" in
      let deep = String.make 100_000 '[' ^ "\n" in
      Support.write_file (transcript_path home) (prompt "before" ^ huge ^ deep ^ prompt "a\xffb" ^ "not json\n");
      let described = cold home in
      Alcotest.(check bool) "invalid bytes dropped, deep and huge lines skipped" true
        (field "last" described = `String "ab");
      Support.write_file (transcript_path home) (prompt "lone \\ud800 surrogate");
      Alcotest.(check bool) "an escaped lone surrogate is U+FFFD" true
        (field "last" (cold home) = `String "lone \xef\xbf\xbd surrogate");
      Support.write_file (transcript_path home) (prompt "only" ^ String.make 100 '{');
      Alcotest.(check bool) "partial last line waits" true (field "last" (cold home) = `String "only"))

let check_no_transcript name described =
  Alcotest.(check bool) (name ^ ": metadata kept") true (field "session_id" described = `String id);
  Alcotest.(check bool) (name ^ ": no transcript field") false (List.mem_assoc "title" described)

let test_hostile_files () =
  with_home (fun home ->
      let path = transcript_path home in
      Sys.remove path;
      Fake.write (path ^ ".real") (prompt "target");
      Unix.symlink (path ^ ".real") path;
      check_no_transcript "symbolic link" (cold home);
      Sys.remove path;
      Unix.mkfifo path 0o600;
      let started = Unix.gettimeofday () in
      check_no_transcript "FIFO" (cold home);
      Alcotest.(check bool) "FIFO answered at once" true (Unix.gettimeofday () -. started < 0.1);
      Sys.remove path;
      if Unix.geteuid () <> 0 then begin
        Support.write_file path (prompt "secret");
        Unix.chmod path 0o000;
        check_no_transcript "unreadable" (cold home);
        Unix.chmod path 0o600
      end)

let test_hostile_directories () =
  with_home (fun home ->
      let projects = Filename.concat home ".claude/projects" in
      Unix.symlink "loop" (Filename.concat projects "loop");
      Unix.mkdir (Filename.concat projects "-other") 0o700;
      Support.write_file (transcript_path home) (prompt "found");
      Alcotest.(check bool) "a link loop is skipped" true (field "last" (cold home) = `String "found"))

(* A newer copy of the transcript created in another project after the first
   was cached is the one read; so is a transcript created after a search
   that found none. *)
let test_newer_copy () =
  with_home (fun home ->
      let projects = Filename.concat home ".claude/projects" in
      Unix.mkdir (Filename.concat projects "-other") 0o700;
      Support.write_file (transcript_path home) (prompt "in A");
      let adapter = fresh home in
      Alcotest.(check bool) "the only copy" true (field "last" (describe adapter) = `String "in A");
      let other = String.concat "/" [ projects; "-other"; id ^ ".jsonl" ] in
      Support.write_file other (prompt "in B newer");
      let later = Unix.time () +. 100. in
      Unix.utimes other later later;
      Alcotest.(check bool) "the newer copy" true (field "last" (describe adapter) = `String "in B newer");
      Sys.remove other;
      Sys.remove (transcript_path home);
      Alcotest.(check bool) "none" false (List.mem_assoc "last" (describe adapter));
      Support.write_file (transcript_path home) (prompt "created");
      Alcotest.(check bool) "created later" true (field "last" (describe adapter) = `String "created"))

let write_metadata home text = Fake.write (Printf.sprintf "%s/.claude/sessions/%d.json" home pid) text

let test_hostile_metadata () =
  with_home (fun home ->
      write_metadata home (String.make 10_000 '[');
      Alcotest.check fields "too deep" [] (cold home);
      write_metadata home ({|{"sessionId":"|} ^ String.make (2 * 1024 * 1024) 'a' ^ {|"}|});
      Alcotest.check fields "too large" [] (cold home);
      write_metadata home {|{"sessionId":"../../etc/passwd","status":true,"statusUpdatedAt":true}|};
      let described = cold home in
      Alcotest.(check bool) "id reported, never used as a path" true
        (field "session_id" described = `String "../../etc/passwd" && not (List.mem_assoc "title" described));
      Alcotest.(check bool) "Python's True / 1000" true (field "since" described = `Float 0.001))

(* A writer appends in random pieces while four threads describe the session
   through one adapter; at the end the cached rows equal a cold read. *)
let test_concurrent_appends () =
  with_home (fun home ->
      let adapter = fresh home and finished = Atomic.make false in
      let writer () =
        let random = Random.State.make [| 7 |] in
        let rec loop offset =
          if offset < String.length sample then begin
            let size = min (1 + Random.State.int random 400) (String.length sample - offset) in
            Support.append_file (transcript_path home) (String.sub sample offset size);
            loop (offset + size)
          end
        in
        for _ = 1 to 20 do loop 0 done;
        Atomic.set finished true
      in
      let reader () = while not (Atomic.get finished) do ignore (describe adapter) done in
      (* A thread's exception is kept and raised again here. *)
      let failure = Atomic.make None in
      let guarded f () = try f () with error -> Atomic.set failure (Some error); Atomic.set finished true in
      let threads = Thread.create (guarded writer) () :: List.init 4 (fun _ -> Thread.create (guarded reader) ()) in
      List.iter Thread.join threads;
      Option.iter raise (Atomic.get failure);
      Alcotest.check fields "cache equals cold" (cold home) (describe adapter))

let () =
  Alcotest.run "mesh_agent_claude"
    [
      ( "cache",
        [
          Alcotest.test_case "pieces equal a cold read" `Quick test_cache_equals_cold;
          Alcotest.test_case "unchanged is not decoded" `Quick test_no_decoding_when_unchanged;
          Alcotest.test_case "concurrent appends" `Quick test_concurrent_appends;
          Alcotest.test_case "100 MB append" `Quick test_large_append;
          Alcotest.test_case "a skip restarts the fold (12b)" `Quick test_skip_restarts_the_fold;
          Alcotest.test_case "a skip drops an answered question (12d)" `Quick test_skip_drops_an_answered_question;
        ] );
      ( "hostile",
        [
          Alcotest.test_case "lines" `Quick test_hostile_lines;
          Alcotest.test_case "files" `Quick test_hostile_files;
          Alcotest.test_case "directories" `Quick test_hostile_directories;
          Alcotest.test_case "newer copy" `Quick test_newer_copy;
          Alcotest.test_case "metadata" `Quick test_hostile_metadata;
        ] );
    ]
