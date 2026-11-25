(* SPDX-License-Identifier: AGPL-3.0-or-later
   Copyright (c) 2026 Atacama <contact@atacama.tech> *)

let with_store f =
  let directory = Filename.temp_file "mesh-conversation" "" in
  Sys.remove directory;
  Unix.mkdir directory 0o700;
  let path = Filename.concat directory "names.json" in
  Fun.protect
    ~finally:(fun () ->
      Array.iter
        (fun name ->
          let path = Filename.concat directory name in
          if Sys.is_directory path then Unix.rmdir path else Sys.remove path)
        (Sys.readdir directory);
      Unix.rmdir directory)
    (fun () -> f path)

let check_json message expected actual =
  let canonical value =
    Yojson.Safe.from_string value |> Yojson.Safe.to_string
  in
  Alcotest.(check string) message (canonical expected) (canonical actual)

let expect ?clock ~path message fields expected =
  let request = {|{"version":1,|} ^ fields ^ "}" in
  let expected = {|{"version":1,"result":|} ^ expected ^ "}" in
  check_json message expected (Conversation_protocol.handle ?clock ~path request)

let read path = In_channel.with_open_bin path In_channel.input_all
let write path value = Out_channel.with_open_bin path (fun out -> output_string out value)

let test_lifecycle () =
  with_store (fun path ->
      let expect message = expect ~path message in
      expect "empty snapshot" {|"op":"snapshot"|} "[]";
      expect "rename before binding"
        {|"op":"rename","now":100,"name":"work","created":1,"old":" Old ","new":"New\u202e"|} "null";
      expect "list binds, projects each session, and retains earlier aliases"
        {|"op":"observe","clock_now":101,"sessions":[{"name":"work","created":1.0,"label":"New","agent":{"type":"pi","session_id":"first-id","identity_source":"unique_pi_transcript"}},{"name":"other","created":2} ]|}
        {|[["work","Old","New"],["other"]]|};
      Alcotest.(check int) "private mode" 0o600
        ((Unix.stat path).st_perm land 0o777);
      expect "last label" {|"op":"last_label","now":102,"agent":"pi","sid":"first-id"|} {|"New"|};
      expect "same SID in another agent does not match"
        {|"op":"enrich","now":102,"agent":"codex","id":"first-id"|} "{}";
      expect "History fields"
        {|"op":"enrich","now":102,"agent":"pi","id":"first-id"|}
        {|{"mesh_name":"work","mesh_label":"New","mesh_aliases":["work","Old","New"]}|};
      expect "close by numerically equal incarnation"
        {|"op":"close","now":103,"name":"work","created":1|} "null";
      expect "stale inventory cannot revive closure or add a new binding"
        {|"op":"observe","clock_now":104,"sessions":[{"name":"work","created":1,"label":"Stale","agent":{"type":"pi","session_id":"second-id","identity_source":"unique_pi_transcript"}}]|}
        {|[["work","Old","New"]]|};
      expect "successful inventory closed its missing second session"
        {|"op":"snapshot","now":104|}
        {|[{"name":"other","created":2,"seen":104,"label":"","aliases":["other"],"agent":null,"sid":null,"closed_at":104},{"name":"work","created":1.0,"seen":103,"label":"New","aliases":["work","Old","New"],"agent":"pi","sid":"first-id","closed_at":103}]|};
      expect "forget exact conversation"
        {|"op":"forget","now":105,"agent":"pi","sid":"first-id"|} "null";
      expect "forgotten history has no label"
        {|"op":"last_label","now":105,"agent":"pi","sid":"first-id"|} {|""|})

let test_binding () =
  with_store (fun path ->
      let expect message = expect ~path message in
      expect "exact Codex binding"
        {|"op":"observe","clock_now":100,"sessions":[{"name":"w","created":1,"label":"Exact","agent":{"type":"codex","session_id":"known-id","identity_source":"open_rollout"}}]|}
        {|[["w","Exact"]]|};
      expect "malformed SID from trusted source falls back to prior conversation"
        {|"op":"observe","clock_now":101,"sessions":[{"name":"w","created":1,"label":"Invalid SID","agent":{"type":"codex","session_id":"short","identity_source":"pid_metadata"}}]|}
        {|[["w","Exact","Invalid SID"]]|};
      expect "null agent falls back to prior conversation"
        {|"op":"observe","clock_now":102,"sessions":[{"name":"w","created":1,"label":"Shell","agent":null}]|}
        {|[["w","Exact","Invalid SID","Shell"]]|};
      expect "prior binding retained"
        {|"op":"last_label","now":102,"agent":"codex","sid":"known-id"|} {|"Shell"|};
      expect "untrusted fallback is an ambiguous identity"
        {|"op":"observe","clock_now":103,"sessions":[{"name":"w","created":1,"label":"Guess","agent":{"type":"codex","session_id":"known-id","identity_source":"cwd_unique"}}]|}
        {|[["w","Exact","Invalid SID","Shell","Guess"]]|};
      expect "untrusted observation left exact label alone"
        {|"op":"last_label","now":103,"agent":"codex","sid":"known-id"|} {|"Shell"|};
      expect "missing source is also ambiguous"
        {|"op":"observe","clock_now":104,"sessions":[{"name":"w","created":1,"label":"Unknown","agent":{"type":"codex","session_id":"known-id"}}]|}
        {|[["w","Exact","Invalid SID","Shell","Guess","Unknown"]]|};
      expect "missing source left exact label alone"
        {|"op":"last_label","now":104,"agent":"codex","sid":"known-id"|} {|"Shell"|})

let test_failed_and_stale_listing () =
  with_store (fun path ->
      let expect ?clock message = expect ?clock ~path message in
      expect "observe"
        {|"op":"observe","clock_now":100,"sessions":[{"name":"w","created":1,"label":"Original"}]|}
        {|[["w","Original"]]|};
      let bytes = read path in
      write path (bytes ^ "\n");
      expect "failed listing projects aliases without mutations"
        {|"op":"observe","clock_now":101,"listed":false,"sessions":[{"name":"missing","created":2},{"name":"w","created":1,"label":"Ignored"}]|}
        {|[[],["w","Original"]]|};
      expect "unchanged successful listing projects without rewrite"
        {|"op":"observe","clock_now":101,"sessions":[{"name":"w","created":1,"label":"Original"}]|}
        {|[["w","Original"]]|};
      Alcotest.(check string) "both reads preserved the file" (bytes ^ "\n") (read path);
      expect "rename records newer data"
        {|"op":"rename","now":105,"name":"w","created":1,"old":"Original","new":"Latest"|} "null";
      let ticks = ref [ 104.; 106.; 107. ] in
      let clock () =
        match !ticks with
        | time :: rest -> ticks := rest; time
        | [] -> Alcotest.fail "unexpected clock sample"
      in
      expect ~clock "stale listing sees newer state"
        {|"op":"observe","sessions":[{"name":"w","created":1,"label":"Original"}]|}
        {|[["w","Original","Latest"]]|};
      Alcotest.(check (list (float 0.))) "all clock samples used" [] !ticks;
      expect "request observation time does not cap the snapshot"
        {|"op":"observe","now":104,"clock_now":107,"sessions":[{"name":"w","created":1,"label":"Original"}]|}
        {|[["w","Original","Latest"]]|})

let test_post_write_clock () =
  with_store (fun path ->
      let sampled = ref false in
      let clock () =
        if !sampled then (
          Alcotest.(check bool) "projection clock sampled after replacement" true
            (Sys.file_exists path);
          100. +. (90. *. 86400.))
        else (
          sampled := true;
          100.)
      in
      expect ~path ~clock "projection expires the row at the exact retention boundary"
        {|"op":"observe","sessions":[{"name":"w","created":1}]|} "[[]]";
      expect ~path "committed observation remains visible at its original time"
        {|"op":"observe","clock_now":100,"listed":false,"sessions":[{"name":"w","created":1}]|}
        {|[["w"]]|})

let test_timestamp_identity () =
  with_store (fun path ->
      let expect message = expect ~path message in
      expect "adjacent integers keep distinct identities past 2^53"
        {|"op":"observe","clock_now":100,"sessions":[{"name":"w","created":9007199254740992,"label":"First"},{"name":"w","created":9007199254740993,"label":"Second"}]|}
        {|[["w","First"],["w","Second"]]|};
      expect "a matching integral float targets only the exact integer"
        {|"op":"close","now":101.0,"name":"w","created":9007199254740992.0|} "null";
      expect "timestamp representation survives a mutation and reload"
        {|"op":"snapshot","now":101|}
        {|[{"name":"w","created":9007199254740992,"seen":101.0,"label":"First","aliases":["w","First"],"agent":null,"sid":null,"closed_at":101.0},{"name":"w","created":9007199254740993,"seen":100,"label":"Second","aliases":["w","Second"],"agent":null,"sid":null,"closed_at":null}]|})

let test_observe_only () =
  with_store (fun path ->
      expect ~path "failed observe-only does no storage work"
        {|"op":"observe","listed":false,"project":false,"sessions":[]|} "null";
      Alcotest.(check (list string)) "neither file was opened" []
        (Array.to_list (Sys.readdir (Filename.dirname path)));
      let clock () = Alcotest.fail "observe-only should neither load nor project on a clock" in
      expect ~path ~clock "observe-only can capture a new session before a kill"
        {|"op":"observe","project":false,"now":100,"sessions":[{"name":"w","created":1}]|} "null";
      expect ~path "new session was captured"
        {|"op":"observe","listed":false,"clock_now":100,"sessions":[{"name":"w","created":1}]|}
        {|[["w"]]|})

let test_unreadable_registry_is_preserved () =
  with_store (fun path ->
      List.iter
        (fun contents ->
          write path contents;
          expect ~path "unreadable registry has no snapshot"
            {|"op":"snapshot","now":101|} "[]";
          check_json "rename cannot replace an unreadable registry"
            {|{"version":1,"error":"registry_io"}|}
            (Conversation_protocol.handle ~path
              {|{"version":1,"op":"rename","name":"w","created":1,"now":101,"old":"","new":"Changed"}|});
          Alcotest.(check string) "file preserved byte for byte" contents (read path))
        [ {|[{"name":"w"|};
          {|[{"name":"w","created":1,"seen":100},{"name":"unsupported","created":9223372036854775808,"seen":100}]|} ])

let test_errors () =
  with_store (fun path ->
      let error message code request =
        check_json message ({|{"version":1,"error":"|} ^ code ^ "\"}")
          (Conversation_protocol.handle ~path request)
      in
      error "malformed JSON" "invalid_request" "{";
      error "future version" "unsupported_version" {|{"version":2,"op":"snapshot"}|};
      error "bool timestamp rejected" "invalid_request"
        {|{"version":1,"op":"close","name":"w","created":true}|};
      error "private field rejected" "invalid_request"
        {|{"version":1,"op":"observe","sessions":[{"name":"w","created":1,"agent":{"argv":[]}}]}|};
      error "a malformed row prevents partial observation" "invalid_request"
        {|{"version":1,"op":"observe","sessions":[{"name":"w","created":1},{"name":"broken"}]}|};
      Alcotest.(check (list string)) "invalid requests left no files" []
        (Array.to_list (Sys.readdir (Filename.dirname path)));
      Unix.mkdir path 0o700;
      error "atomic write failure" "registry_io"
        {|{"version":1,"op":"close","name":"w","created":1,"now":101}|};
      Alcotest.(check bool) "destination preserved" true (Sys.is_directory path))

let () =
  Alcotest.run "conversation protocol"
    [ "protocol",
      [ Alcotest.test_case "lifecycle" `Quick test_lifecycle;
        Alcotest.test_case "binding" `Quick test_binding;
        Alcotest.test_case "failed and stale listings" `Quick test_failed_and_stale_listing;
        Alcotest.test_case "post-write clock" `Quick test_post_write_clock;
        Alcotest.test_case "timestamp identity" `Quick test_timestamp_identity;
        Alcotest.test_case "observe without projection" `Quick test_observe_only;
        Alcotest.test_case "unreadable registry is preserved" `Quick test_unreadable_registry_is_preserved;
        Alcotest.test_case "errors" `Quick test_errors ] ]
