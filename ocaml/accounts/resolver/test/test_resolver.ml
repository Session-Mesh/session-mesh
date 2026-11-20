(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* Mesh_account_resolver: which (backend, id) exist, name resolution, the
   guarantees on the source, and the folders it prepares. *)

module R = Mesh_account_resolver

let uid = Unix.geteuid ()

let alias ?claude ?codex id label : Mesh_accounts.account =
  { id; label; claude_config_dir = claude; codex_home = codex }

(* work serves both agents, travel Codex only, spare Claude only with a label
   equal to the default account's ignoring case. *)
let accounts =
  [
    alias "work" "Work" ~claude:"/r/work/claude" ~codex:"/r/work/codex";
    alias "travel" "Travel" ~codex:"/r/travel-codex";
    alias "spare" "DEFAULT ACCOUNT" ~claude:"/r/spare";
  ]

let ok = function
  | Ok value -> value
  | Error (error : R.error) -> Alcotest.failf "%s: %s" error.code error.message

let of_list list = ok (R.of_accounts list)
let fixture () = of_list accounts

let show_ref (r : R.account_ref) =
  Printf.sprintf "%s/%s" (R.backend_to_string r.backend) r.id

let refused code = function
  | Ok entry -> Alcotest.failf "expected %s, got %s" code (show_ref (R.ref_ entry))
  | Error (error : R.error) -> Alcotest.(check string) "code" code error.code

let check_ref what expected entry =
  Alcotest.(check string) what expected (show_ref (R.ref_ entry))

let test_list () =
  Alcotest.(check (list string))
    "declared accounts, file order, Claude first"
    [ "claude/work"; "codex/work"; "codex/travel"; "claude/spare" ]
    (List.map (fun e -> show_ref (R.ref_ e)) (R.list (fixture ())))

let test_find () =
  let t = fixture () in
  check_ref "codex travel" "codex/travel"
    (ok (R.find t { backend = Codex; id = "travel" }));
  refused "account_no_agent" (R.find t { backend = Claude; id = "travel" });
  refused "account_unknown" (R.find t { backend = Claude; id = "nobody" });
  let default = ok (R.find t { backend = Codex; id = "default" }) in
  Alcotest.(check string) "default label" "Default account" (R.label default);
  Alcotest.(check (list (pair string string)))
    "default runs with no variable" [] (R.launch_env default)

let test_serves () =
  let t = fixture () in
  Alcotest.(check bool) "travel, Codex" true (R.serves t ~id:"travel" Codex);
  Alcotest.(check bool) "travel, Claude" false (R.serves t ~id:"travel" Claude);
  Alcotest.(check bool) "default, Claude" true (R.serves t ~id:"default" Claude);
  Alcotest.(check bool) "unknown" false (R.serves t ~id:"nobody" Codex)

let test_resolve () =
  let t = fixture () in
  let resolve backend name = R.resolve_name t backend name in
  check_ref "exact id" "claude/work" (ok (resolve Claude "work"));
  check_ref "label, any ASCII case" "codex/work" (ok (resolve Codex "WORK"));
  check_ref "label, mixed case" "codex/travel" (ok (resolve Codex "tRaVeL"));
  refused "account_no_agent" (resolve Claude "travel");
  refused "account_unknown" (resolve Claude "Travel");
  refused "account_unknown" (resolve Codex "wor");
  refused "account_unknown" (resolve Codex "trav");
  refused "account_unknown" (resolve Codex "");
  check_ref "default by id" "claude/default" (ok (resolve Claude "default"));
  check_ref "default label, one candidate in Codex" "codex/default"
    (ok (resolve Codex "default account"));
  refused "account_ambiguous" (resolve Claude "default account");
  Alcotest.(check (list string))
    "candidates" [ "claude/default"; "claude/spare" ]
    (List.map
       (fun e -> show_ref (R.ref_ e))
       (R.label_matches t Claude "Default Account"))

let test_id_before_label () =
  let t =
    of_list
      [
        alias "alpha" "Beta" ~claude:"/r/alpha";
        alias "beta" "Alpha" ~claude:"/r/beta";
      ]
  in
  check_ref "the id wins" "claude/beta" (ok (R.resolve_name t Claude "beta"));
  check_ref "a label that is no id" "claude/alpha"
    (ok (R.resolve_name t Claude "BETA"))

let test_refused_sources () =
  let refuses what list =
    match R.of_accounts list with
    | Ok _ -> Alcotest.failf "%s accepted" what
    | Error (error : R.error) ->
        Alcotest.(check string) what "accounts_refused" error.code
  in
  refuses "default in the source" [ alias "default" "D" ~codex:"/r/d" ];
  refuses "upper-case id" [ alias "Work" "W" ~codex:"/r/d" ];
  refuses "long id" [ alias (String.make 33 'a') "W" ~codex:"/r/d" ];
  refuses "long label" [ alias "w" (String.make 25 'x') ~codex:"/r/d" ];
  refuses "control in label" [ alias "w" "a\nb" ~codex:"/r/d" ];
  refuses "path to quote" [ alias "w" "W" ~codex:"/r/a b" ];
  refuses "relative path" [ alias "w" "W" ~codex:"r/d" ];
  refuses "dot-dot path" [ alias "w" "W" ~codex:"/r/../d" ];
  refuses "no folder" [ alias "w" "W" ];
  refuses "same id twice"
    [ alias "w" "A" ~codex:"/r/a"; alias "w" "B" ~codex:"/r/b" ];
  refuses "same label in a backend, other case"
    [ alias "a" "Work" ~codex:"/r/a"; alias "b" "WORK" ~codex:"/r/b" ];
  (* the same label in two backends names two different accounts *)
  ignore (of_list [ alias "a" "Work" ~claude:"/r/a"; alias "b" "WORK" ~codex:"/r/b" ])

let test_launch_env_and_roots () =
  let t = fixture () in
  let env backend id = R.launch_env (ok (R.find t { backend; id })) in
  Alcotest.(check (list (pair string string)))
    "Claude" [ ("CLAUDE_CONFIG_DIR", "/r/work/claude") ] (env Claude "work");
  Alcotest.(check (list (pair string string)))
    "Codex" [ ("CODEX_HOME", "/r/work/codex") ] (env Codex "work");
  Alcotest.(check (list string))
    "protected roots"
    [ "/r/work/claude"; "/r/work/codex"; "/r/travel-codex"; "/r/spare" ]
    (R.protected_roots t)

let test_describe_and_host_json () =
  let t = fixture () in
  let describe backend current =
    Yojson.Safe.to_string (R.describe_current t backend current)
  in
  Alcotest.(check string) "default"
    {|{"id":"default","label":"Default account","declared":true}|}
    (describe Claude None);
  Alcotest.(check string) "declared"
    {|{"id":"work","label":"Work","declared":true}|}
    (describe Claude (Some "work"));
  Alcotest.(check string) "other backend only"
    {|{"id":"travel","label":"travel","declared":false}|}
    (describe Claude (Some "travel"));
  Alcotest.(check string) "host JSON"
    (Yojson.Safe.to_string
       (`Assoc [ ("accounts", `List (List.map Mesh_accounts.to_json accounts)) ]))
    (Yojson.Safe.to_string (R.to_host_json t));
  Alcotest.(check string) "entry JSON, no folder"
    {|{"backend":"codex","id":"travel","label":"Travel"}|}
    (Yojson.Safe.to_string (R.entry_json (ok (R.find t { backend = Codex; id = "travel" }))))

(* ----------------------------------------------------------- the folders *)

let temporary () =
  let base =
    Filename.concat (Filename.get_temp_dir_name ()) "mesh-resolver-test"
  in
  (try Unix.mkdir base 0o700 with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
  Unix.realpath (Filename.temp_dir ~temp_dir:base ~perms:0o700 "t" "")

let is_private_directory path =
  match Unix.lstat path with
  | { Unix.st_kind = Unix.S_DIR; st_perm; _ } -> st_perm land 0o777 = 0o700
  | _ | (exception Unix.Unix_error _) -> false

let write_file path text =
  Out_channel.with_open_gen
    [ Open_wronly; Open_creat; Open_trunc ]
    0o600 path
    (fun channel -> output_string channel text)

let test_prepare () =
  let root = temporary () in
  let folder name = Filename.concat root name in
  let t =
    of_list
      [ alias "work" "Work" ~claude:(folder "claude") ~codex:(folder "codex") ]
  in
  let codex = ok (R.find t { backend = Codex; id = "work" }) in
  ignore (ok (R.prepare ~uid codex));
  Alcotest.(check bool) "Codex folder created" true
    (is_private_directory (folder "codex"));
  Alcotest.(check bool) "only that account's folder" false
    (Sys.file_exists (folder "claude"));
  ignore (ok (R.prepare_id ~uid t "work"));
  Alcotest.(check bool) "prepare_id creates every folder" true
    (is_private_directory (folder "claude"));
  (match R.prepare_id ~uid t "default" with
  | Ok _ -> Alcotest.fail "default prepared from the source"
  | Error error -> Alcotest.(check string) "default" "account_unknown" error.code);
  let orphan =
    of_list [ alias "lost" "Lost" ~codex:(folder "missing/codex") ]
  in
  refused "account_folder_refused"
    (R.prepare ~uid (ok (R.find orphan { backend = Codex; id = "lost" })))

let test_carry_folder () =
  let root = temporary () in
  let home = Filename.concat root "home" in
  Unix.mkdir home 0o700;
  let t = of_list [ alias "work" "Work" ~codex:(Filename.concat root "codex") ] in
  let getenv = function "HOME" -> Some home | _ -> None in
  let default = ok (R.find t { backend = Claude; id = "default" }) in
  ignore (ok (R.carry_folder ~uid ~getenv ~create:false default));
  Alcotest.(check bool) "checked, not created" false
    (Sys.file_exists (Filename.concat home ".claude"));
  Alcotest.(check string) "default under HOME"
    (Filename.concat home ".claude")
    (ok (R.carry_folder ~uid ~getenv ~create:true default));
  let configured = Filename.concat root "configured" in
  let getenv = function
    | "CLAUDE_CONFIG_DIR" -> Some configured
    | "HOME" -> Some home
    | _ -> None
  in
  Alcotest.(check string) "CLAUDE_CONFIG_DIR first" configured
    (ok (R.carry_folder ~uid ~getenv ~create:true default));
  let work = ok (R.find t { backend = Codex; id = "work" }) in
  Alcotest.(check string) "an alias's folder" (Filename.concat root "codex")
    (ok (R.carry_folder ~uid ~getenv:(fun _ -> None) ~create:true work));
  match R.carry_folder ~uid ~getenv:(fun _ -> None) ~create:true default with
  | Ok _ -> Alcotest.fail "no HOME accepted"
  | Error error -> Alcotest.(check string) "no HOME" "account_folder_refused" error.code

(* The folders are checked, never opened: an unreadable login file inside
   changes nothing. *)
let test_load_reads_no_login_file () =
  let root = temporary () in
  let claude = Filename.concat root "claude" in
  Unix.mkdir claude 0o700;
  let secret = Filename.concat claude ".credentials.json" in
  write_file secret "{}";
  Unix.chmod secret 0o000;
  let file = Filename.concat root "accounts.json" in
  write_file file
    (Printf.sprintf
       {|{"v": 1, "accounts": [{"id": "work", "label": "Work", "claude_config_dir": "%s"}]}|}
       claude);
  let t = ok (R.load ~uid ~file) in
  ignore (ok (R.prepare_id ~uid t "work"));
  write_file file "{";
  match R.load ~uid ~file with
  | Ok _ -> Alcotest.fail "invalid file accepted"
  | Error error ->
      Alcotest.(check string) "refused" "accounts_refused" error.code;
      Alcotest.(check string) "reason" "accounts.json is not JSON" error.message

let () =
  Alcotest.run "mesh_account_resolver"
    [
      ( "lookup",
        [
          Alcotest.test_case "list" `Quick test_list;
          Alcotest.test_case "find" `Quick test_find;
          Alcotest.test_case "serves" `Quick test_serves;
          Alcotest.test_case "resolve a name" `Quick test_resolve;
          Alcotest.test_case "id before label" `Quick test_id_before_label;
          Alcotest.test_case "refused sources" `Quick test_refused_sources;
          Alcotest.test_case "launch env, roots" `Quick test_launch_env_and_roots;
          Alcotest.test_case "describe, host JSON" `Quick
            test_describe_and_host_json;
        ] );
      ( "folders",
        [
          Alcotest.test_case "prepare" `Quick test_prepare;
          Alcotest.test_case "carry folder" `Quick test_carry_folder;
          Alcotest.test_case "no login file read" `Quick
            test_load_reads_no_login_file;
        ] );
    ]
