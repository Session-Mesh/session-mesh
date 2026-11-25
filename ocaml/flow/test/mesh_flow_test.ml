(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)

let with_directory f =
  let dir = Test_scratch.private_directory "mesh-flow-test-" in
  Fun.protect
    ~finally:(fun () ->
      Array.iter
        (fun name -> Unix.unlink (Filename.concat dir name))
        (Sys.readdir dir);
      Unix.rmdir dir)
    (fun () -> f dir)

let identity id created =
  `Assoc
    [ ("id", `String id); ("created", `Int created); ("agent", `String "codex") ]

let event id =
  `Assoc
    [
      ("id", `String id);
      ("kind", `String "message");
      ("time", `Int 123);
      ("source", identity "source" 1);
      ("target", identity "target" 2);
    ]

let expect_failure label f =
  let rejected = try f (); false with _ -> true in
  Alcotest.(check bool) label true rejected

let save path value =
  let out =
    open_out_gen [ Open_wronly; Open_creat; Open_trunc; Open_binary ] 0o600 path
  in
  Fun.protect
    ~finally:(fun () -> close_out_noerr out)
    (fun () -> Yojson.Safe.to_channel out value)

let contents path = In_channel.with_open_bin path In_channel.input_all

let contains text needle =
  let rec loop i =
    i + String.length needle <= String.length text
    && (String.sub text i (String.length needle) = needle || loop (i + 1))
  in
  loop 0

let record_and_validate () =
  with_directory (fun dir ->
      let one = event "one" in
      Mesh_flow.write dir one;
      Mesh_flow.write dir one;
      let events, truncated = Mesh_flow.state (Mesh_flow.read dir) in
      Alcotest.(check bool) "identical retry recorded once" true (events = [ one ]);
      Alcotest.(check bool) "no retention yet" false truncated;
      let other =
        match one with
        | `Assoc fields -> `Assoc (("text", `String "secret") :: fields)
        | _ -> assert false
      in
      expect_failure "reject message body" (fun () -> Mesh_flow.write dir other);
      let conflict =
        match one with
        | `Assoc fields ->
            `Assoc
              (List.map
                 (fun (key, value) ->
                   if key = "time" then (key, `Int 124) else (key, value))
                 fields)
        | _ -> assert false
      in
      expect_failure "reject conflicting retry" (fun () -> Mesh_flow.write dir conflict);
      let after, _ = Mesh_flow.state (Mesh_flow.read dir) in
      Alcotest.(check bool) "failed writes preserve data" true (after = [ one ]);
      let raw = contents (Filename.concat dir "flow-events.json") in
      Alcotest.(check bool) "secret absent from journal" false (contains raw "secret"))

let retention () =
  with_directory (fun dir ->
      let initial =
        List.init Mesh_flow.capacity (fun i -> event ("id" ^ string_of_int i))
      in
      save (Filename.concat dir "flow-events.json")
        (`Assoc [ ("events", `List initial); ("truncated", `Bool false) ]);
      Mesh_flow.write dir (event "new");
      let events, truncated = Mesh_flow.state (Mesh_flow.read dir) in
      Alcotest.(check int) "bounded" Mesh_flow.capacity (List.length events);
      Alcotest.(check bool) "truncation reported" true truncated;
      Alcotest.(check bool) "oldest removed" true (List.hd events = event "id1");
      Alcotest.(check bool)
        "newest retained" true
        (List.hd (List.rev events) = event "new"))

let protected_paths () =
  with_directory (fun dir ->
      let target = Filename.concat dir "missing-target" in
      let lock = Filename.concat dir "flow-events.lock" in
      Unix.symlink target lock;
      expect_failure "dangling lock refused" (fun () ->
          Mesh_flow.write dir (event "one"));
      Alcotest.(check bool) "dangling target not created" false (Sys.file_exists target);
      Unix.unlink lock;
      let journal = Filename.concat dir "flow-events.json" in
      save target (`String "unchanged");
      let before = contents target in
      Unix.symlink target journal;
      expect_failure "symlink journal refused" (fun () ->
          Mesh_flow.write dir (event "two"));
      Alcotest.(check string) "symlink target unchanged" before (contents target);
      Unix.unlink journal;
      Unix.link target journal;
      expect_failure "hard link journal refused" (fun () ->
          Mesh_flow.write dir (event "three"));
      Alcotest.(check string) "hard link target unchanged" before (contents target);
      Unix.unlink journal;
      save journal Mesh_flow.empty;
      Unix.chmod journal 0o644;
      expect_failure "non-private journal refused" (fun () ->
          Mesh_flow.write dir (event "four")))

let concurrent_writers () =
  with_directory (fun dir ->
      let children =
        List.init 16 (fun i ->
            match Unix.fork () with
            | 0 -> (
                try
                  Mesh_flow.write dir (event ("child" ^ string_of_int i));
                  exit 0
                with _ -> exit 1)
            | pid -> pid)
      in
      List.iter
        (fun pid ->
          let _, status = Unix.waitpid [] pid in
          Alcotest.(check bool) "writer succeeds" true (status = Unix.WEXITED 0))
        children;
      let events, truncated = Mesh_flow.state (Mesh_flow.read dir) in
      Alcotest.(check int) "all writers retained" 16 (List.length events);
      Alcotest.(check bool) "not truncated" false truncated;
      List.iter
        (fun i ->
          Alcotest.(check bool)
            "writer event retained" true
            (List.mem (event ("child" ^ string_of_int i)) events))
        (List.init 16 Fun.id))

let () =
  Alcotest.run "flow journal"
    [ ("storage", [
          Alcotest.test_case "validated retry" `Quick record_and_validate;
          Alcotest.test_case "bounded retention" `Quick retention;
          Alcotest.test_case "unsafe paths" `Quick protected_paths;
          Alcotest.test_case "concurrent writers" `Quick concurrent_writers;
        ]) ]
