(* SPDX-License-Identifier: AGPL-3.0-or-later *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech> *)
module A = Mesh_session_artifacts

let id name n = `Assoc [ ("name", `String name); ("created", `Int n) ]

let reference connector key =
  `Assoc
    [
      ("connector", `String connector);
      ("id", `String key);
      ("kind", `String "note");
      ("title", `String "Example");
      ("url", `String "https://example.invalid/s/fixture");
      ("availability", `String "pending-target");
      ("created_at", `Int 1);
      ("updated_at", `Int 2);
    ]

let count root id =
  A.catalogue root id |> A.get "references" |> A.list |> List.length

let temp f =
  let root = Filename.temp_file "mesh-artifacts-" "" in
  Sys.remove root;
  Unix.mkdir root 0o700;
  Fun.protect
    ~finally:(fun () ->
      Array.iter
        (fun p -> Sys.remove (Filename.concat root p))
        (Sys.readdir root);
      Unix.rmdir root)
    (fun () -> f root)

let lifecycle () =
  temp (fun root ->
      let a = id "a" 1 and b = id "b" 2 in
      ignore (A.observe root a (reference "notes" "one"));
      ignore (A.observe root a (reference "notes" "one"));
      Alcotest.(check int) "dedup/reopen" 1 (count root a);
      Alcotest.(check int) "name reuse" 0 (count root (id "a" 2));
      ignore (A.observe root a (reference "other" "one"));
      Alcotest.(check int) "connector scope" 2 (count root a);
      ignore (A.transfer root a b);
      Alcotest.(check int) "old gone" 0 (count root a);
      Alcotest.(check int) "exact transfer" 2 (count root b);
      ignore (A.revoke root b "notes" "one");
      let rs = A.catalogue root b |> A.get "references" |> A.list in
      let r = List.find (fun r -> A.get "connector" r = `String "notes") rs in
      Alcotest.(check bool)
        "revoked capability removed" true
        (A.get "url" r = `Null);
      ignore (A.remove root b);
      Alcotest.(check int) "removed" 0 (count root b))

let invalid () =
  temp (fun root ->
      let bad =
        `Assoc
          (("url", `String "javascript:alert(1)")
          :: List.remove_assoc "url" (A.fields (reference "notes" "x")))
      in
      Alcotest.check_raises "unsafe link" A.Invalid (fun () ->
          ignore (A.observe root (id "a" 1) bad));
      let duplicate =
        `Assoc
          [ ("name", `String "a"); ("name", `String "b"); ("created", `Int 1) ]
      in
      Alcotest.check_raises "duplicate" A.Invalid (fun () ->
          ignore (A.catalogue root duplicate));
      Unix.chmod root 0o755;
      Alcotest.check_raises "private root" A.Invalid (fun () ->
          ignore (A.catalogue root (id "a" 1)));
      Unix.chmod root 0o700)

let bounded () =
  temp (fun root ->
      for i = 1 to 128 do
        ignore (A.observe root (id "a" 1) (reference "notes" (string_of_int i)))
      done;
      Alcotest.check_raises "capacity" A.Invalid (fun () ->
          ignore (A.observe root (id "a" 1) (reference "notes" "overflow")));
      Alcotest.(check int) "old state preserved" 128 (count root (id "a" 1));
      ignore (A.observe root (id "b" 2) (reference "notes" "existing"));
      Alcotest.check_raises "transfer cannot overwrite" A.Invalid (fun () ->
          ignore (A.transfer root (id "a" 1) (id "b" 2)));
      Alcotest.(check int) "source preserved" 128 (count root (id "a" 1));
      let ch = open_out (Filename.concat root "session-artifacts.json") in
      output_string ch "broken";
      close_out ch;
      Alcotest.(check bool)
        "corruption fails closed" true
        (try
           ignore (count root (id "a" 1));
           false
         with _ -> true))

let connector () =
  let args = `Assoc [ ("path", `String "a.md"); ("label", `String "A") ] in
  Mesh_notes_connector.validate_call "mint_share" args;
  Alcotest.check_raises "caller identity forbidden" A.Invalid (fun () ->
      Mesh_notes_connector.validate_call "mint_share"
        (`Assoc (("session_id", `String "other") :: A.fields args)));
  let p =
    `Assoc
      [
        ("id", `String "share-id");
        ("share_url", `String "https://example.invalid/s/fixture");
        ("scope_kind", `String "note");
        ("scope_path", `String "a.md");
        ("target_present", `Bool false);
      ]
  in
  let result = `Assoc [ ("structuredContent", p) ] in
  let obs =
    Mesh_notes_connector.observation
      (Uri.of_string "https://example.invalid/mcp")
      "mint_share" args result
  in
  Alcotest.(check bool)
    "absent target explicit" true
    (A.get "availability" (A.get "reference" obs) = `String "pending-target");
  Alcotest.check_raises "other origin forbidden" A.Invalid (fun () ->
      ignore
        (Mesh_notes_connector.observation
           (Uri.of_string "https://other.invalid/mcp")
           "mint_share" args result));
  Alcotest.check_raises "unconfirmed revoke" A.Invalid (fun () ->
      ignore
        (Mesh_notes_connector.observation
           (Uri.of_string "https://example.invalid/mcp")
           "revoke_share"
           (`Assoc [ ("id", `String "share-id") ])
           (`Assoc
              [ ("structuredContent", `Assoc [ ("revoked", `Bool false) ]) ])))

let concurrent () =
  temp (fun root ->
      flush_all ();
      let children =
        List.init 8 (fun i ->
            match Unix.fork () with
            | 0 -> (
                try
                  ignore
                    (A.observe root (id "a" 1)
                       (reference "notes" (string_of_int i)));
                  exit 0
                with _ -> exit 1)
            | pid -> pid)
      in
      List.iter
        (fun pid ->
          Alcotest.(check bool)
            "writer completed" true
            (snd (Unix.waitpid [] pid) = Unix.WEXITED 0))
        children;
      Alcotest.(check int)
        "no cross-process lost updates" 8
        (count root (id "a" 1));
      let st = Unix.stat (Filename.concat root "session-artifacts.json") in
      Alcotest.(check int)
        "private persisted capability file" 0
        (st.Unix.st_perm land 0o077))

let ordering () =
  temp (fun root ->
      let begin_ () =
        match A.get "generation" (A.begin_observation root) with
        | `Int n -> n
        | _ -> assert false
      in
      let delayed = begin_ () in
      ignore (A.revoke root (id "b" 2) "notes" "shared");
      ignore
        (A.observe ~generation:delayed root (id "a" 1)
           (reference "notes" "shared"));
      let row () =
        A.catalogue root (id "a" 1) |> A.get "references" |> A.list |> List.hd
      in
      Alcotest.(check bool)
        "revoke before first observation" true
        (A.get "url" (row ()) = `Null);
      let fresh = begin_ () in
      ignore
        (A.observe ~generation:fresh root (id "a" 1)
           (reference "notes" "shared"));
      Alcotest.(check bool)
        "fresh later confirmation allowed" true
        (A.get "url" (row ()) <> `Null);
      ignore
        (A.observe ~generation:delayed root (id "a" 1)
           (reference "notes" "shared"));
      Alcotest.(check bool)
        "old result cannot overwrite fresh" true
        (A.get "generation" (row ()) = `Int fresh);
      ignore (A.revoke root (id "b" 2) "notes" "shared");
      Alcotest.(check bool)
        "other session revoke" true
        (A.get "url" (row ()) = `Null))

let outcomes () =
  List.iter
    (fun reason ->
      let p =
        `Assoc
          [
            ("status", `String "error");
            ("reason", `String reason);
            ("message", `String "fixture");
          ]
      in
      List.iter
        (fun result ->
          Alcotest.(check bool)
            reason true
            (Mesh_notes_connector.write_outcome "create_note" result
            = `String "upstream-error"))
        [
          `Assoc [ ("structuredContent", p) ];
          `Assoc
            [
              ( "content",
                `List
                  [
                    `Assoc
                      [
                        ("type", `String "text");
                        ("text", `String (Yojson.Safe.to_string p));
                      ];
                  ] );
            ];
        ])
    [
      "outside_root";
      "already_exists";
      "missing_target";
      "missing_parent";
      "too_large";
      "not_text";
      "not_a_file";
      "io_error";
      "unreachable";
      "unauthorized";
      "missing_share";
      "not_configured";
      "endpoint_failure";
      "invalid_argument";
    ]

let legacy_revocation () =
  temp (fun root ->
      let active = reference "notes" "legacy" in
      let revoked = A.tombstone active in
      let old =
        `Assoc
          [
            ("version", `Int 1);
            ( "sessions",
              `List
                [
                  A.entry (id "a" 1) [ active ]; A.entry (id "b" 2) [ revoked ];
                ] );
          ]
      in
      let path = Filename.concat root "session-artifacts.json" in
      let ch =
        open_out_gen [ Open_wronly; Open_creat; Open_trunc ] 0o600 path
      in
      output_string ch (Yojson.Safe.to_string old);
      close_out ch;
      let row =
        A.catalogue root (id "a" 1) |> A.get "references" |> A.list |> List.hd
      in
      Alcotest.(check bool)
        "v1 cross-session revoke remains authoritative" true
        (A.get "url" row = `Null))

let transfer_proof () =
  temp (fun root ->
      let a = id "a" 1 and b = id "b" 2 in
      Alcotest.check_raises "absence is not empty proof" A.Invalid (fun () ->
          ignore (A.transfer root a b));
      Alcotest.(check bool)
        "transfer does not initialize missing catalogue" false
        (Sys.file_exists (Filename.concat root "session-artifacts.json"));
      ignore (A.begin_observation root);
      let absent = A.transfer root a b in
      Alcotest.(check bool)
        "new empty store does not prove old scope empty" true
        (A.get "transfer_status" absent = `String "source-absent");
      ignore
        (A.with_store root (fun (entries, barriers, generation) ->
             (`Null, Some (A.entry a [] :: entries, barriers, generation))));
      let empty = A.transfer root a b in
      Alcotest.(check bool)
        "valid existing empty scope" true
        (A.get "transfer_status" empty = `String "source-empty"
        && A.get "catalogue_present" empty = `Bool true
        && A.get "transferred" empty = `Bool false);
      ignore (A.observe root a (reference "notes" "proof"));
      let moved = A.transfer root a b in
      Alcotest.(check bool)
        "published move" true
        (A.get "transfer_status" moved = `String "moved"
        && A.get "transferred" moved = `Bool true);
      let retry = A.transfer root a b in
      Alcotest.(check bool)
        "retry obtains exact target provenance" true
        (A.get "transfer_status" retry = `String "already-moved"
        && A.get "catalogue_present" retry = `Bool true);
      Alcotest.(check int) "committed target retains reference" 1 (count root b);
      ignore (A.observe root b (reference "notes" "later"));
      ignore (A.revoke root b "notes" "proof");
      Alcotest.(check bool)
        "proof survives normalization/observe/revoke" true
        (A.get "transfer_status" (A.transfer root a b) = `String "already-moved"))

let knowledge_proof () =
  temp (fun root ->
      let a = id "a" 1 in
      Alcotest.check_raises "missing file cannot emit zero proof" A.Invalid
        (fun () -> ignore (A.catalogue root a));
      ignore (A.begin_observation root);
      let absent = A.catalogue root a in
      Alcotest.(check bool)
        "existing empty store has no source proof" true
        (A.get "catalogue_present" absent = `Bool true
        && A.get "source_present" absent = `Bool false);
      ignore
        (A.with_store root (fun (entries, barriers, generation) ->
             (`Null, Some (A.entry a [] :: entries, barriers, generation))));
      let zero = A.catalogue root a in
      Alcotest.(check bool)
        "explicit zero scope is affirmative" true
        (A.get "catalogue_present" zero = `Bool true
        && A.get "source_present" zero = `Bool true
        && A.get "references" zero = `List []);
      Sys.rename
        (Filename.concat root "session-artifacts.json")
        (Filename.concat root "backup.json");
      Alcotest.check_raises "disappearance cannot synthesize zero proof"
        A.Invalid (fun () -> ignore (A.catalogue root a)))

let native_routing () =
  temp (fun root ->
      let module W = Mesh_artifacts_worker in
      let before = id "source" 1 and after = id "restored" 2 in
      let store = Filename.concat root "session-artifacts.json" in
      let check label expected value =
        Alcotest.(check bool) label expected value
      in
      check "absence stays unknown" true
        (A.get "required" (A.restore_probe root before) = `Bool true);
      let prepare tool =
        W.prepare root
          (`Assoc
             [
               ("op", `String "notes-prepare");
               ("session", before);
               ("nonce", `String "fixture");
               ("tool", `String tool);
             ])
      in
      check "missing grant denies" true
        (A.get "allowed" (prepare "mint_share") = `Bool false);
      check "denial creates no catalogue" false (Sys.file_exists store);
      let path = Filename.concat root "notes-grants.json" in
      let fd =
        Unix.openfile path [ Unix.O_WRONLY; Unix.O_CREAT; Unix.O_EXCL ] 0o600
      in
      let channel = Unix.out_channel_of_descr fd in
      output_string channel
        "{\"version\":1,\"sessions\":[{\"name\":\"source\",\"created\":1,\"nonce\":\"fixture\",\"tools\":[\"create_note\",\"mint_share\",\"revoke_share\"]}]}";
      close_out channel;
      check "create granted without generation" true
        (A.get "allowed" (prepare "create_note") = `Bool true);
      check "create admission does not initialize catalogue" false
        (Sys.file_exists store);
      let admission = prepare "mint_share" in
      let generation = A.get "generation" admission in
      check "share admits durable generation" true (generation = `Int 1);
      let record attributed observation =
        W.record root
          (`Assoc
             [
               ("op", `String "notes-record");
               ("session", before);
               ("generation", generation);
               ("attributed", `Bool attributed);
               ( "outcome",
                 `Assoc
                   [
                     ("status", `String "success"); ("observation", observation);
                   ] );
             ])
      in
      let observation =
        `Assoc
          [
            ("action", `String "observe");
            ("reference", reference "notes" "fixture");
          ]
      in
      check "ended source cannot record mint" true
        (A.get "catalogue" (record false observation) = `String "not-recorded");
      let success = record true observation in
      check "live source records mint" true
        (A.get "catalogue" success = `String "recorded");
      check "internal observation removed" false
        (List.mem_assoc "observation" (A.fields success));
      let revoked =
        record false
          (`Assoc [ ("action", `String "revoke"); ("id", `String "fixture") ])
      in
      check "ended source still clears confirmed revoke" true
        (A.get "catalogue" revoked = `String "recorded");
      ignore (record true observation);
      let saved =
        List.hd (A.list (A.get "references" (A.catalogue root before)))
      in
      check "delayed mint remains revoked" true (A.get "url" saved = `Null);
      check "unknown action refuses mutation" true
        (A.get "catalogue"
           (record true (`Assoc [ ("action", `String "remove") ]))
        = `String "not-recorded");
      ignore
        (A.with_store root (fun (entries, barriers, counter) ->
             ( `Null,
               Some (A.entry (id "empty" 3) [] :: entries, barriers, counter) )));
      check "affirmative source zero" true
        (A.get "required" (A.restore_probe root (id "empty" 3)) = `Bool false);
      check "native zero transfer completion" true
        (A.get "complete" (A.restore_transfer root (id "empty" 3) after)
        = `Bool true);
      check "native absent source cannot complete" true
        (A.get "complete" (A.restore_transfer root (id "absent" 4) after)
        = `Bool false);
      Unix.chmod store 0o644;
      check "admission storage failure remains unavailable, not denied" true
        (A.get "status" (prepare "mint_share") = `String "unavailable");
      check "unsafe catalogue stays unknown" true
        (A.get "required" (A.restore_probe root before) = `Bool true);
      check "store failure after upstream success is partial" true
        (A.get "catalogue" (record true observation) = `String "not-recorded"))

let () =
  Alcotest.run "session artifacts"
    [
      ( "catalogue",
        [
          Alcotest.test_case "lifecycle" `Quick lifecycle;
          Alcotest.test_case "validation" `Quick invalid;
          Alcotest.test_case "bounds/corruption" `Quick bounded;
          Alcotest.test_case "concurrent writers" `Quick concurrent;
          Alcotest.test_case "ordered global revocation" `Quick ordering;
          Alcotest.test_case "legacy global revocation" `Quick legacy_revocation;
          Alcotest.test_case "transfer completion proof" `Quick transfer_proof;
          Alcotest.test_case "restore knowledge proof" `Quick knowledge_proof;
          Alcotest.test_case "native admission recording and restore policy"
            `Quick native_routing;
        ] );
      ( "connector",
        [
          Alcotest.test_case "validation" `Quick connector;
          Alcotest.test_case "Outcome variants" `Quick outcomes;
        ] );
    ]
