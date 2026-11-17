(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module Store = Mesh_history_store
module Query = Mesh_history_query

let with_dir f =
  let dir = Filename.temp_file "mesh-history" "" in
  Sys.remove dir;
  Unix.mkdir dir 0o700;
  Fun.protect
    ~finally:(fun () ->
      Array.iter (fun n -> Sys.remove (Filename.concat dir n)) (Sys.readdir dir);
      Unix.rmdir dir)
    (fun () -> f dir)

let ok = function
  | Ok v -> v
  | Error (e : Store.error) -> Alcotest.failf "unexpected error %s: %s" e.code e.message

let error_code = function
  | Ok _ -> Alcotest.fail "an error was expected"
  | Error (e : Store.error) -> e.code

let with_store ?busy_timeout_ms f =
  with_dir (fun dir ->
      let path = Filename.concat dir "h.sqlite" in
      let store = ok (Store.open_ ?busy_timeout_ms ~path ()) in
      Fun.protect ~finally:(fun () -> Store.close store) (fun () -> f store path))

let conv ?(title = "") ?(summary = "") agent id =
  { Store.agent; id; path = "/t/" ^ id; cwd = "/w"; title; started = Some 1.; updated = Some 2.;
    tokens = None; summary; meta = {|{"branch":"main"}|} }

let chunk seq text = { Store.seq; role = "user"; text }
let ids hits = List.map (fun (h : Store.hit) -> h.agent ^ ":" ^ h.id) hits
let search store q = ids (ok (Store.search store ~query:q ~limit:50))
let strings = Alcotest.(list string)

(* ---- query building ---- *)

let expr = Alcotest.(option string)

let test_query_shapes () =
  Alcotest.check expr "two terms, last is a prefix" (Some {|"foo" "bar"*|})
    (Query.match_expression "foo bar");
  Alcotest.check expr "operators are plain terms" (Some {|"a" "AND" "b" "OR" "NOT" "c"*|})
    (Query.match_expression "a AND b OR NOT c");
  Alcotest.check expr "quotes, stars, columns and parentheses are separators"
    (Some {|"x" "text" "NEAR" "2"*|})
    (Query.match_expression {|"x" * (text): ^ - NEAR/2 :|});
  Alcotest.check expr "nothing searchable" None (Query.match_expression {| "" - * ( ) |});
  Alcotest.check expr "NUL and controls separate" (Some {|"a" "b"*|})
    (Query.match_expression "a\000\001b");
  Alcotest.check expr "accents kept" (Some {|"café"*|}) (Query.match_expression "café");
  Alcotest.check expr "invalid UTF-8 separates" (Some {|"a" "b"*|})
    (Query.match_expression "a\xff\xfe b")

let test_query_limits () =
  let many = String.concat " " (List.init 100 (fun i -> "w" ^ string_of_int i)) in
  (match Query.match_expression many with
  | Some e -> Alcotest.(check int) "terms capped" Query.max_terms
                (List.length (String.split_on_char ' ' e))
  | None -> Alcotest.fail "expected an expression");
  let long = String.make 100_000 'a' in
  match Query.match_expression long with
  | Some e -> Alcotest.(check bool) "term truncated" true (String.length e < 200)
  | None -> Alcotest.fail "expected an expression"

(* ---- migrations ---- *)

let test_migration_from_empty () =
  with_dir (fun dir ->
      let path = Filename.concat dir "h.sqlite" in
      let s = ok (Store.open_ ~path ()) in
      Alcotest.(check (list int)) "versions" [ 1; 2 ] (ok (Store.applied_versions s));
      Alcotest.(check string) "tokenizer" "unicode61 remove_diacritics 2" (ok (Store.tokenizer s));
      ignore (ok (Store.ingest s (conv "claude" "a") [ chunk 0 "hello" ]));
      Store.close s;
      let again = ok (Store.open_ ~path ()) in
      Alcotest.(check (list int)) "reopen applies nothing" [ 1; 2 ] (ok (Store.applied_versions again));
      Alcotest.(check strings) "data survives" [ "claude:a" ] (search again "hello");
      Store.close again;
      Alcotest.(check int) "mode 0600" 0o600 ((Unix.stat path).Unix.st_perm land 0o777))

let test_newer_schema_refused () =
  with_dir (fun dir ->
      let path = Filename.concat dir "h.sqlite" in
      Store.close (ok (Store.open_ ~path ()));
      let db = Sqlite3.db_open path in
      ignore (Sqlite3.exec db "INSERT INTO schema_migrations VALUES (99, 0)");
      ignore (Sqlite3.db_close db);
      Alcotest.(check string) "refused" "bad_request" (error_code (Store.open_ ~path ())))

(* ---- ingest, FTS ---- *)

let test_ingest_idempotent () =
  with_store (fun s _ ->
      let c = conv ~title:"Titre" "claude" "a" and chunks = [ chunk 0 "alpha"; chunk 1 "beta" ] in
      ignore (ok (Store.ingest s c chunks));
      ignore (ok (Store.ingest s c chunks));
      let stats = ok (Store.stats s) in
      Alcotest.(check int) "one conversation" 1 stats.conversations;
      Alcotest.(check int) "two chunks and the title" 3 stats.chunks;
      Alcotest.(check strings) "found once" [ "claude:a" ] (search s "alpha");
      ignore (ok (Store.ingest s c [ chunk 1 "gamma" ]));
      Alcotest.(check strings) "old text gone from the index" [] (search s "beta");
      Alcotest.(check strings) "new text indexed" [ "claude:a" ] (search s "gamma");
      Alcotest.(check strings) "untouched chunk kept" [ "claude:a" ] (search s "alpha"))

let test_replace_chunks_and_append () =
  with_store (fun s _ ->
      let c = conv "codex" "x" in
      ignore (ok (Store.ingest s c [ chunk 0 "first"; chunk 1 "second" ]));
      ignore (ok (Store.ingest s c [ chunk 2 "third" ]));
      Alcotest.(check int) "appended" 3 (ok (Store.stats s)).chunks;
      ignore (ok (Store.ingest s ~replace_chunks:true c [ chunk 0 "only" ]));
      Alcotest.(check int) "replaced" 1 (ok (Store.stats s)).chunks;
      Alcotest.(check strings) "old gone" [] (search s "second"))

let test_negative_seq_rejected () =
  with_store (fun s _ ->
      Alcotest.(check string) "bad_request" "bad_request"
        (error_code (Store.ingest s (conv "claude" "a") [ chunk (-1) "no" ])))

let test_french_accents () =
  with_store (fun s _ ->
      ignore
        (ok
           (Store.ingest s (conv ~title:"Réunion à l'Élysée" "claude" "fr")
              [ chunk 0 "Le café était délicieux, c'est l'été"; chunk 1 "ÉCOLE normale" ]));
      Alcotest.(check strings) "unaccented query" [ "claude:fr" ] (search s "cafe delicieux");
      Alcotest.(check strings) "accented query" [ "claude:fr" ] (search s "café");
      Alcotest.(check strings) "upper case" [ "claude:fr" ] (search s "ecole");
      Alcotest.(check strings) "title" [ "claude:fr" ] (search s "elysee");
      Alcotest.(check strings) "prefix on the last term" [ "claude:fr" ] (search s "delici");
      Alcotest.(check strings) "absent" [] (search s "poisson"))

let test_one_hit_per_conversation_ranked () =
  with_store (fun s _ ->
      ignore (ok (Store.ingest s (conv "claude" "a") [ chunk 0 "mesh mesh mesh mesh"; chunk 1 "mesh" ]));
      ignore (ok (Store.ingest s (conv "codex" "b") [ chunk 0 "mesh and a lot of other words here" ]));
      let hits = ok (Store.search s ~query:"mesh" ~limit:10) in
      Alcotest.(check strings) "best first, one each" [ "claude:a"; "codex:b" ] (ids hits);
      Alcotest.(check int) "limit" 1 (List.length (ok (Store.search s ~query:"mesh" ~limit:1)));
      Alcotest.(check bool) "snippet is plain text" true
        (List.for_all (fun (h : Store.hit) -> h.snippet <> "") hits))

let hostile =
  [ {|"|}; {|""|}; {|" OR 1=1 --|}; {|'; DROP TABLE chunks; --|}; "a AND"; "NOT"; "NEAR(a b, 1)";
    "text:foo"; "{text}: foo"; "foo*"; "^foo"; "-foo"; "(("; "))"; "\000"; "a\000b";
    "\xff\xfe"; String.make 1_000_000 'x'; String.concat " " (List.init 5000 string_of_int);
    "*"; "AND OR NOT"; "foo -bar"; "col1 : \"x" ]

let test_hostile_queries () =
  with_store (fun s _ ->
      ignore (ok (Store.ingest s (conv "claude" "a") [ chunk 0 "foo bar DROP TABLE" ]));
      List.iter
        (fun q ->
          match Store.search s ~query:q ~limit:5 with
          | Ok _ -> ()
          | Error e -> Alcotest.failf "query %S failed: %s" (String.escaped (String.sub q 0 (min 20 (String.length q)))) e.message)
        hostile;
      Alcotest.(check int) "table intact" 1 (ok (Store.stats s)).chunks;
      Alcotest.(check strings) "operator word is a term, not an operator" []
        (search s "foo AND zzz"))

(* ---- forget, generations ---- *)

let test_forget () =
  with_store (fun s _ ->
      ignore (ok (Store.ingest s (conv ~title:"t" "claude" "a") [ chunk 0 "needle" ]));
      Alcotest.(check bool) "removed" true (ok (Store.forget s ~agent:"claude" ~id:"a" ()) <> None);
      Alcotest.(check strings) "gone from search" [] (search s "needle");
      Alcotest.(check strings) "title too" [] (search s "t");
      Alcotest.(check int) "no chunk left" 0 (ok (Store.stats s)).chunks;
      Alcotest.(check bool) "unknown id" true (ok (Store.forget s ~agent:"claude" ~id:"a" ()) = None))

let listed_ids (l : Store.listing) =
  List.map (fun (x : Store.listed) -> x.conversation.id) l.sessions

let test_list_generations () =
  with_store (fun s _ ->
      let g1 = ok (Store.ingest s ~gen:1_000_000_000_000_000_000 (conv "claude" "a") []) in
      let first = ok (Store.list s ~since:None ()) in
      Alcotest.(check bool) "full without since" true first.full;
      Alcotest.(check int) "current" g1 first.current;
      let g2 = ok (Store.ingest s (conv "claude" "b") []) in
      Alcotest.(check int) "next generation follows" (g1 + 1) g2;
      let delta = ok (Store.list s ~since:(Some g1) ()) in
      Alcotest.(check bool) "delta" false delta.full;
      Alcotest.(check strings) "only the newer one" [ "b" ] (listed_ids delta);
      let g3 = Option.get (ok (Store.forget s ~agent:"claude" ~id:"a" ())) in
      let after = ok (Store.list s ~since:(Some g2) ()) in
      Alcotest.(check strings) "removal reported" [ "claude:a" ]
        (List.map (fun (a, i) -> a ^ ":" ^ i) after.gone);
      Alcotest.(check int) "generation" g3 after.current;
      let idle = ok (Store.list s ~since:(Some g3) ()) in
      Alcotest.(check (pair strings strings)) "nothing changed" ([], [])
        (listed_ids idle, List.map fst idle.gone);
      Alcotest.(check bool) "future generation gets everything" true
        (ok (Store.list s ~since:(Some (g3 + 1_000)) ())).full;
      Alcotest.(check bool) "the caller's own current generation decides" false
        (ok (Store.list s ~current:(g3 + 2_000) ~since:(Some (g3 + 1_000)) ())).full;
      ignore (ok (Store.ingest s (conv "claude" "a") []));
      let back = ok (Store.list s ~since:(Some g3) ()) in
      Alcotest.(check strings) "re-ingested id is no longer gone" [] (List.map fst back.gone))

let test_list_content_and_order () =
  with_store (fun s _ ->
      let older = { (conv ~summary:"sum" "claude" "old") with updated = Some 10. } in
      let newer = { (conv "claude" "new") with updated = Some 20. } in
      ignore (ok (Store.ingest s older []));
      ignore (ok (Store.ingest s newer []));
      let l = ok (Store.list s ~since:None ()) in
      Alcotest.(check strings) "newest first" [ "new"; "old" ] (listed_ids l);
      let o = List.nth l.sessions 1 in
      Alcotest.(check (pair bool string)) "summary flag, no body" (true, "") (o.has_summary, o.conversation.summary);
      match ok (Store.detail s ~agent:"claude" ~id:"old") with
      | Some (d, summary) ->
          Alcotest.(check string) "summary in detail" "sum" summary;
          Alcotest.(check string) "path" "/t/old" d.conversation.path;
          Alcotest.(check string) "meta kept" {|{"branch":"main"}|} d.conversation.meta
      | None -> Alcotest.fail "detail missing")

let test_cursor_roundtrip () =
  with_store (fun s _ ->
      ignore (ok (Store.ingest s ~cursor:{ offset = 4096; next_seq = 7; epoch = 3 } (conv "claude" "a") []));
      ignore (ok (Store.ingest s (conv "claude" "a") [ chunk 7 "more" ]));
      match ok (Store.cursors s) with
      | [ ((agent, id, path), c, _) ] ->
          Alcotest.(check (list string)) "key" [ "claude"; "a"; "/t/a" ] [ agent; id; path ];
          Alcotest.(check (list int)) "kept when not resent" [ 4096; 7; 3 ] [ c.offset; c.next_seq; c.epoch ]
      | _ -> Alcotest.fail "one cursor expected")

let test_empty_chunk_removes_it () =
  with_store (fun s _ ->
      let c = conv "claude" "a" in
      ignore (ok (Store.ingest s c [ chunk 0 "alpha"; chunk 1_000_000_000 "nomdistinct" ]));
      Alcotest.(check strings) "name found" [ "claude:a" ] (search s "nomdistinct");
      ignore (ok (Store.ingest s c [ chunk 1_000_000_000 "" ]));
      Alcotest.(check strings) "name gone" [] (search s "nomdistinct");
      Alcotest.(check strings) "text kept" [ "claude:a" ] (search s "alpha"))

let test_epoch_migration_default () =
  with_dir (fun dir ->
      let path = Filename.concat dir "h.sqlite" in
      let s = ok (Store.open_ ~path ()) in
      ignore (ok (Store.ingest s (conv "claude" "a") []));
      (match ok (Store.cursors s) with
      | [ (_, c, _) ] -> Alcotest.(check int) "epoch defaults to 0" 0 c.epoch
      | _ -> Alcotest.fail "one cursor expected");
      Alcotest.(check bool) "sqlite version" true (String.length (ok (Store.sqlite_version s)) >= 5);
      Store.close s)

(* ---- failure paths ---- *)

let test_locked_database () =
  with_store ~busy_timeout_ms:50 (fun s path ->
      let raw = Sqlite3.db_open path in
      Fun.protect
        ~finally:(fun () -> ignore (Sqlite3.db_close raw))
        (fun () ->
          ignore (Sqlite3.exec raw "BEGIN IMMEDIATE");
          Alcotest.(check string) "write while locked" "busy"
            (error_code (Store.ingest s (conv "claude" "a") [ chunk 0 "x" ]));
          Alcotest.(check strings) "reads still work in WAL mode" [] (search s "x");
          ignore (Sqlite3.exec raw "ROLLBACK"));
      ignore (ok (Store.ingest s (conv "claude" "a") [ chunk 0 "x" ]));
      Alcotest.(check strings) "works again" [ "claude:a" ] (search s "x"))

let write_file path content =
  let oc = open_out_bin path in
  output_string oc content;
  close_out oc

let test_corrupt_database () =
  with_dir (fun dir ->
      let path = Filename.concat dir "h.sqlite" in
      write_file path (String.make 8192 'g');
      Alcotest.(check string) "garbage file" "corrupt" (error_code (Store.open_ ~path ())))

let test_protocol_survives () =
  with_dir (fun dir ->
      let path = Filename.concat dir "h.sqlite" in
      write_file path (String.make 8192 'g');
      let p = Mesh_history_protocol.create ~open_store:(fun () -> Store.open_ ~path ()) in
      let code line =
        let j = Yojson.Safe.from_string (Mesh_history_protocol.handle_line p line) in
        match Yojson.Safe.Util.(member "ok" j, member "error" j) with
        | `Bool true, _ -> "ok"
        | _, e -> Yojson.Safe.Util.(member "code" e |> to_string)
      in
      Alcotest.(check string) "corrupt answered" "corrupt" (code {|{"op":"stats"}|});
      Alcotest.(check string) "still answering" "corrupt" (code {|{"op":"list"}|});
      Alcotest.(check string) "bad json" "bad_request" (code "{nope");
      Alcotest.(check string) "not an object" "bad_request" (code "[1]");
      Sys.remove path;
      Alcotest.(check string) "recovers once the file is sane" "ok" (code {|{"op":"stats"}|}))

let test_protocol_requests () =
  with_store (fun s _ ->
      let p = Mesh_history_protocol.create ~open_store:(fun () -> Ok s) in
      let call line = Yojson.Safe.from_string (Mesh_history_protocol.handle_line p line) in
      let member = Yojson.Safe.Util.member in
      let r = call {|{"req":"r1","op":"ingest","agent":"claude","id":"a","title":"T","chunks":[{"seq":0,"role":"user","text":"zebra"}],"meta":{"n_user":3,"title":"ignored"}}|} in
      Alcotest.(check bool) "req echoed" true (member "req" r = `String "r1");
      let hits = call {|{"op":"search","q":"zebra","mode":"text","limit":5}|} in
      Alcotest.(check int) "found" 1 (List.length Yojson.Safe.Util.(member "results" hits |> to_list));
      let l = call {|{"op":"list"}|} in
      let first = List.hd Yojson.Safe.Util.(member "sessions" l |> to_list) in
      Alcotest.(check bool) "meta merged" true (member "n_user" first = `Int 3);
      Alcotest.(check bool) "meta does not override" true (member "title" first = `String "T");
      let semantic = call {|{"op":"search","q":"zebra","mode":"semantic"}|} in
      Alcotest.(check bool) "semantic not offered" true (member "ok" semantic = `Bool false);
      let bad = call {|{"op":"ingest","agent":"claude","id":"b","chunks":[{"seq":"x","text":"t"}]}|} in
      Alcotest.(check bool) "bad chunk" true (member "ok" bad = `Bool false);
      let unknown = call {|{"op":"drop"}|} in
      Alcotest.(check bool) "unknown op" true (member "ok" unknown = `Bool false))

let () =
  Alcotest.run "mesh_history"
    [ ( "query",
        [ Alcotest.test_case "shapes" `Quick test_query_shapes;
          Alcotest.test_case "limits" `Quick test_query_limits ] );
      ( "schema",
        [ Alcotest.test_case "migration from empty" `Quick test_migration_from_empty;
          Alcotest.test_case "newer schema refused" `Quick test_newer_schema_refused ] );
      ( "store",
        [ Alcotest.test_case "ingest is idempotent" `Quick test_ingest_idempotent;
          Alcotest.test_case "replace and append chunks" `Quick test_replace_chunks_and_append;
          Alcotest.test_case "negative seq" `Quick test_negative_seq_rejected;
          Alcotest.test_case "French and accents" `Quick test_french_accents;
          Alcotest.test_case "ranking, one hit per conversation" `Quick test_one_hit_per_conversation_ranked;
          Alcotest.test_case "hostile queries" `Quick test_hostile_queries;
          Alcotest.test_case "forget" `Quick test_forget;
          Alcotest.test_case "list generations" `Quick test_list_generations;
          Alcotest.test_case "list content and order" `Quick test_list_content_and_order;
          Alcotest.test_case "cursor" `Quick test_cursor_roundtrip;
          Alcotest.test_case "empty chunk removes it" `Quick test_empty_chunk_removes_it;
          Alcotest.test_case "epoch and sqlite version" `Quick test_epoch_migration_default ] );
      ( "failure",
        [ Alcotest.test_case "locked database" `Quick test_locked_database;
          Alcotest.test_case "corrupt database" `Quick test_corrupt_database;
          Alcotest.test_case "protocol survives" `Quick test_protocol_survives;
          Alcotest.test_case "protocol requests" `Quick test_protocol_requests ] ) ]
