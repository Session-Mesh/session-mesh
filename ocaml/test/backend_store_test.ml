(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

module S = Mesh_backend_store
module C = Mesh_backend_consent

let ( let* ) = Result.bind
let value = function Ok v -> v | Error e -> Alcotest.fail (S.error_code e)

let rec remove path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; _ } ->
      Array.iter (fun n -> remove (Filename.concat path n)) (Sys.readdir path);
      Unix.rmdir path
  | _ -> Unix.unlink path
  | exception Unix.Unix_error (Unix.ENOENT, _, _) -> ()

let with_root f =
  let root = Test_scratch.private_directory "backend-store-" in
  Fun.protect ~finally:(fun () -> remove root) (fun () -> f root)

let with_store root f =
  let store = value (S.open_ ~root ()) in
  Fun.protect ~finally:(fun () -> ignore (S.close store)) (fun () -> f store)

let skip state =
  match
    C.set_global state ~expected_revision:(C.revision state)
      ~confirmation:C.Skip
  with
  | Ok v -> Ok v
  | Error _ -> Error S.Invalid_state

let save_skip tx =
  let* policy = S.policy tx in
  let* policy = skip policy in
  S.set_policy tx policy

let persistence () =
  with_root (fun root ->
      with_store root (fun store ->
          Alcotest.(check int)
            "initial policy" 0
            (C.revision (value (S.read_policy store)));
          ignore
            (value
               (S.transaction store ~expected_revision:0 (fun tx ->
                    let* () = save_skip tx in
                    S.put_operation tx ~id:"switch-1"
                      (`Assoc [ ("phase", `String "prepared") ])))));
      with_store root (fun store ->
          let policy = value (S.read_policy store) in
          Alcotest.(check int) "durable revision" 1 (C.revision policy);
          ignore
            (value
               (S.transaction store ~expected_revision:1 (fun tx ->
                    let* op = S.get_operation tx ~id:"switch-1" in
                    Alcotest.(check bool)
                      "same atomic operation" true
                      (op = Some (`Assoc [ ("phase", `String "prepared") ]));
                    Ok ())))))

let rollback () =
  with_root (fun root ->
      with_store root (fun store ->
          let result =
            S.transaction store ~expected_revision:0 (fun tx ->
                let* () = save_skip tx in
                let* () =
                  S.put_operation tx ~id:"switch-1"
                    (`Assoc [ ("phase", `String "committed") ])
                in
                Error S.Aborted)
          in
          Alcotest.(check bool) "callback refused" true (Result.is_error result);
          Alcotest.(check int)
            "policy rolled back" 0
            (C.revision (value (S.read_policy store)));
          ignore
            (value
               (S.transaction store ~expected_revision:0 (fun tx ->
                    let* op = S.get_operation tx ~id:"switch-1" in
                    Alcotest.(check bool) "journal rolled back" true (op = None);
                    Ok ())))))

let conflicts () =
  with_root (fun root ->
      with_store root (fun first ->
          with_store root (fun second ->
              ignore
                (value (S.transaction first ~expected_revision:0 save_skip));
              let stale =
                S.transaction second ~expected_revision:0 (fun tx ->
                    S.put_operation tx ~id:"stale" (`Assoc []))
              in
              Alcotest.(check bool)
                "stale writer rejected" true (stale = Error S.Conflict);
              ignore
                (value
                   (S.transaction second ~expected_revision:1 (fun tx ->
                        let* op = S.get_operation tx ~id:"stale" in
                        Alcotest.(check bool)
                          "stale operation absent" true (op = None);
                        Ok ()))))))

let transaction_scope () =
  with_root (fun root ->
      with_store root (fun store ->
          let captured = ref None in
          ignore
            (value
               (S.transaction store ~expected_revision:0 (fun tx ->
                    captured := Some tx;
                    Alcotest.(check bool)
                      "nested transaction refuses" true
                      (S.transaction store ~expected_revision:0 (fun _ -> Ok ())
                      = Error S.Busy);
                    Ok ())));
          match !captured with
          | None -> Alcotest.fail "missing transaction"
          | Some tx ->
              Alcotest.(check bool)
                "expired transaction rejected" true
                (S.policy tx = Error S.Invalid_state)))

let unsafe_paths () =
  with_root (fun root ->
      Unix.chmod root 0o755;
      Alcotest.(check bool)
        "nonprivate root" true
        (Result.is_error (S.open_ ~root ()));
      Unix.chmod root 0o700;
      with_store root (fun _ -> ());
      let file = Filename.concat root "backend-accounts.sqlite" in
      Unix.chmod file 0o644;
      Alcotest.(check bool)
        "nonprivate database" true
        (Result.is_error (S.open_ ~root ()));
      Unix.chmod file 0o600)

let exception_rollback () =
  with_root (fun root ->
      with_store root (fun store ->
          let result =
            S.transaction store ~expected_revision:0 (fun tx ->
                ignore (value (save_skip tx));
                failwith "private callback body")
          in
          Alcotest.(check bool)
            "exception projected" true (result = Error S.Aborted);
          Alcotest.(check int)
            "exception rolled back" 0
            (C.revision (value (S.read_policy store)))))

let invalid_rows () =
  with_root (fun root ->
      with_store root (fun store ->
          List.iter
            (fun (id, body) ->
              Alcotest.(check bool)
                "invalid internal row" true
                (Result.is_error
                   (S.transaction store ~expected_revision:0 (fun tx ->
                        S.put_operation tx ~id body))))
            [
              ("../escape", `Assoc []);
              ("id", `List []);
              ("id", `Assoc [ ("phase", `String (String.make 65537 'x')) ]);
              ("id", `Assoc [ ("phase", `String "\255") ]);
              ("id", `Assoc [ ("phase", `String "a"); ("phase", `String "b") ]);
            ]))

let ignored_error_rolls_back () =
  with_root (fun root ->
      with_store root (fun store ->
          let result =
            S.transaction store ~expected_revision:0 (fun tx ->
                let* () = save_skip tx in
                ignore (S.put_operation tx ~id:"bad/path" (`Assoc []));
                Ok ())
          in
          Alcotest.(check bool)
            "ignored failure poisons transaction" true
            (result = Error S.Invalid_state);
          Alcotest.(check int)
            "no partial policy" 0
            (C.revision (value (S.read_policy store)))))

let foreign_schema () =
  with_root (fun root ->
      let file = Filename.concat root "backend-accounts.sqlite" in
      let db = Sqlite3.db_open file in
      if Sqlite3.exec db "PRAGMA user_version=2" <> Sqlite3.Rc.OK then
        Alcotest.fail "fixture schema";
      ignore (Sqlite3.db_close db);
      Unix.chmod file 0o600;
      let before = In_channel.with_open_bin file In_channel.input_all in
      Alcotest.(check bool)
        "newer version refused" true
        (match S.open_ ~root () with
        | Error S.Unsupported_version -> true
        | _ -> false);
      Alcotest.(check string)
        "foreign file untouched" before
        (In_channel.with_open_bin file In_channel.input_all))

let alias_refusal () =
  with_root (fun root ->
      let actual = Filename.concat root "actual" in
      Unix.mkdir actual 0o700;
      let alias = Filename.concat root "alias" in
      Unix.symlink actual alias;
      Alcotest.(check bool)
        "root symlink refused" true
        (Result.is_error (S.open_ ~root:alias ()));
      with_store actual (fun _ -> ());
      let db = Filename.concat actual "backend-accounts.sqlite" in
      let linked = Filename.concat root "linked" in
      Unix.link db linked;
      Alcotest.(check bool)
        "hardlinked database refused" true
        (Result.is_error (S.open_ ~root:actual ()));
      Unix.unlink linked)

let foreign_unversioned () =
  with_root (fun root ->
      let file = Filename.concat root "backend-accounts.sqlite" in
      let db = Sqlite3.db_open file in
      if Sqlite3.exec db "CREATE TABLE unrelated(value TEXT)" <> Sqlite3.Rc.OK
      then Alcotest.fail "fixture schema";
      ignore (Sqlite3.db_close db);
      Unix.chmod file 0o600;
      let before = In_channel.with_open_bin file In_channel.input_all in
      Alcotest.(check bool)
        "unrelated schema refused" true
        (match S.open_ ~root () with
        | Error S.Invalid_state -> true
        | _ -> false);
      Alcotest.(check string)
        "unrelated data unchanged" before
        (In_channel.with_open_bin file In_channel.input_all))

let quoted_root () =
  with_root (fun root ->
      let nested = Filename.concat root "accounts % # ? ' $" in
      Unix.mkdir nested 0o700;
      with_store nested (fun store ->
          ignore (value (S.transaction store ~expected_revision:0 save_skip)));
      with_store nested (fun store ->
          Alcotest.(check int)
            "literal URI path reopens" 1
            (C.revision (value (S.read_policy store)))))

let moved_store () =
  with_root (fun root ->
      with_store root (fun store ->
          let file = Filename.concat root "backend-accounts.sqlite" in
          Unix.rename file (Filename.concat root "retired.sqlite");
          Alcotest.(check bool)
            "a moved database loses native write custody" true
            (S.transaction store ~expected_revision:0 save_skip
            = Error S.Unsafe_store)))

let () =
  Alcotest.run "backend state store"
    [
      ( "transactions",
        [
          Alcotest.test_case "atomic durable policy and journal" `Quick
            persistence;
          Alcotest.test_case "rollback both records" `Quick rollback;
          Alcotest.test_case "cross-connection revision conflict" `Quick
            conflicts;
          Alcotest.test_case "transaction lifetime and nesting" `Quick
            transaction_scope;
          Alcotest.test_case "private root and file" `Quick unsafe_paths;
          Alcotest.test_case "exception rollback" `Quick exception_rollback;
          Alcotest.test_case "bounded internal rows" `Quick invalid_rows;
          Alcotest.test_case "ignored error cannot partially commit" `Quick
            ignored_error_rolls_back;
          Alcotest.test_case "foreign schema refused unchanged" `Quick
            foreign_schema;
          Alcotest.test_case "root and file aliases refused" `Quick
            alias_refusal;
          Alcotest.test_case "unversioned foreign schema refused" `Quick
            foreign_unversioned;
          Alcotest.test_case "literal private path characters" `Quick
            quoted_root;
          Alcotest.test_case "database custody remains current" `Quick
            moved_store;
        ] );
    ]
