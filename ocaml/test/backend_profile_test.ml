(******************************************************************************)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                  *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                            *)
(******************************************************************************)

module P = Mesh_backend_profile

let value = function Ok v -> v | Error e -> Alcotest.fail (P.error_code e)
let s x = `String x

let roots kind prefix =
  let names =
    match kind with
    | "claude" | "pi" -> [ "config"; "history" ]
    | "codex" -> [ "config"; "state" ]
    | _ -> [ "config"; "data"; "state"; "cache" ]
  in
  `Assoc (List.map (fun key -> (key, s (prefix ^ "/" ^ key))) names)

let entry ?label ?(enabled = true) kind id prefix =
  let label = Option.value label ~default:id in
  `Assoc
    [
      ("id", s id);
      ("label", s label);
      ("backend", s kind);
      ("enabled", `Bool enabled);
      ("roots", roots kind prefix);
    ]

let config entries =
  Yojson.Safe.to_string
    (`Assoc [ ("version", `Int 1); ("profiles", `List entries) ])

let replace key v = function
  | `Assoc xs -> `Assoc ((key, v) :: List.remove_assoc key xs)
  | _ -> assert false

let reject text =
  Alcotest.(check bool) "rejected" true (Result.is_error (P.of_string text))

let singleton text =
  match P.profiles (value (P.of_string text)) with
  | [ p ] -> p
  | _ -> Alcotest.fail "one profile expected"

let four_backends () =
  let entries =
    List.mapi
      (fun i kind ->
        entry kind ("p" ^ string_of_int i) ("/profiles/p" ^ string_of_int i))
      [ "claude"; "codex"; "opencode-v2"; "pi" ]
  in
  let registry = value (P.of_string (config entries)) in
  Alcotest.(check int)
    "four typed backends" 4
    (List.length (P.profiles registry));
  List.iter
    (fun p ->
      Alcotest.(check int)
        "context digest" 64
        (String.length (P.context_revision p)))
    (P.profiles registry)

let rename_identity () =
  let a = entry "pi" "work" "/profiles/work" in
  let p = singleton (config [ a ])
  and q = singleton (config [ replace "label" (s "Renamed") a ]) in
  Alcotest.(check string)
    "label excluded from context" (P.context_revision p) (P.context_revision q);
  let changed = singleton (config [ entry "pi" "work" "/profiles/other" ]) in
  Alcotest.(check bool)
    "roots change context" true
    (P.context_revision p <> P.context_revision changed);
  Alcotest.(check bool)
    "registry revision changes" true
    (P.registry_revision (value (P.of_string (config [ a ])))
    <> P.registry_revision
         (value (P.of_string (config [ replace "label" (s "Renamed") a ]))))

let resolve () =
  let registry =
    value
      (P.of_string
         (config
            [
              entry "pi" "work" "/p/a";
              entry ~enabled:false "codex" "off" "/p/b";
            ]))
  in
  let p =
    value (P.resolve registry ~id:"work" ~backend:P.Pi ~expected_context:None)
  in
  ignore
    (value
       (P.resolve registry ~id:"work" ~backend:P.Pi
          ~expected_context:(Some (P.context_revision p))));
  let bad id backend expected =
    Alcotest.(check bool)
      "resolution refuses" true
      (Result.is_error
         (P.resolve registry ~id ~backend ~expected_context:expected))
  in
  bad "missing" P.Pi None;
  bad "off" P.Codex None;
  bad "work" P.Claude None;
  bad "work" P.Pi (Some (String.make 64 '0'))

let public_projection () =
  let p =
    singleton (config [ entry "opencode-v2" "work" "/private/account-root" ])
  in
  let public = P.public_json p in
  let text = Yojson.Safe.to_string public in
  Alcotest.(check bool) "no private paths" false (String.contains text '/');
  match public with
  | `Assoc xs ->
      Alcotest.(check bool) "no roots" false (List.mem_assoc "roots" xs);
      Alcotest.(check bool)
        "switch unqualified" true
        (List.assoc_opt "switch_qualified" xs = Some (`Bool false))
  | _ -> Alcotest.fail "public object expected"

let strict_schema () =
  List.iter reject
    [
      "";
      "{}";
      "[]";
      "null";
      "{\"version\":1,\"version\":1,\"profiles\":[]}";
      "{\"version\":1.0,\"profiles\":[]}";
      "{\"version\":2,\"profiles\":[]}";
      "{\"version\":1,\"profiles\":[],\"env\":{}}";
      config [ replace "enabled" (`Int 1) (entry "pi" "a" "/p/a") ];
      config [ replace "backend" (s "unknown") (entry "pi" "a" "/p/a") ];
      config [ replace "label" (s "\255") (entry "pi" "a" "/p/a") ];
      config [ replace "label" (s "bad\nlabel") (entry "pi" "a" "/p/a") ];
      config
        [ replace "label" (s (String.make 161 'x')) (entry "pi" "a" "/p/a") ];
      config [ replace "id" (s "a/b") (entry "pi" "a" "/p/a") ];
      config [ replace "id" (s "") (entry "pi" "a" "/p/a") ];
    ];
  ignore (value (P.of_string (config [])))

let paths () =
  let base = entry "pi" "a" "/p/a" in
  List.iter
    (fun path ->
      reject
        (config
           [
             replace "roots"
               (`Assoc [ ("config", s path); ("history", s "/shared/history") ])
               base;
           ]))
    [
      "/";
      "relative";
      "~/account";
      "/a/../b";
      "/a/./b";
      "/a//b";
      "/a/";
      "/bad\000path";
    ];
  reject
    (config
       [
         replace "roots"
           (`Assoc
              [
                ("config", s "/p/a");
                ("history", s "/shared");
                ("secret", s "no");
              ])
           base;
       ]);
  reject (config [ entry "pi" "a" "/p/a"; entry "pi" "a" "/p/b" ]);
  reject
    (config [ entry "pi" "a" "/p/a"; entry "claude" "b" "/p/a/config/nested" ]);
  let shared e =
    replace "roots"
      (`Assoc
         [
           ("config", s (if e = "a" then "/p/a" else "/p/b"));
           ("history", s "/shared/history");
         ])
      (entry "pi" e "/unused")
  in
  ignore (value (P.of_string (config [ shared "a"; shared "b" ])))

let bounds () =
  reject (String.make ((1024 * 1024) + 1) ' ');
  let entries count =
    List.init count (fun i ->
        let id = "a" ^ string_of_int i in
        entry "pi" id ("/profiles/" ^ id))
  in
  Alcotest.(check int)
    "64 dual-backend aliases fit" 128
    (List.length (P.profiles (value (P.of_string (config (entries 128))))));
  reject (config (entries 129))

let filesystem_roots () =
  let root = Test_scratch.private_directory "backend-profile-" in
  let config_dir = Filename.concat root "config"
  and history = Filename.concat root "history" in
  Unix.mkdir config_dir 0o700;
  Unix.mkdir history 0o700;
  Fun.protect
    ~finally:(fun () ->
      Unix.chmod root 0o700;
      Unix.rmdir config_dir;
      Unix.rmdir history;
      Unix.rmdir root)
    (fun () ->
      let p = singleton (config [ entry "pi" "work" root ]) in
      ignore (value (P.validate_roots p));
      Unix.chmod root 0o777;
      Alcotest.(check bool)
        "writable ancestor refused" true
        (Result.is_error (P.validate_roots p));
      Unix.chmod root 0o700;
      Unix.chmod config_dir 0o777;
      Alcotest.(check bool)
        "writable config root refused" true
        (Result.is_error (P.validate_roots p));
      Unix.chmod config_dir 0o700)

let registry_file () =
  let root = Test_scratch.private_directory "backend-registry-" in
  let file = Filename.concat root "backend-profiles.json"
  and other = Filename.concat root "other" in
  Fun.protect
    ~finally:(fun () ->
      List.iter
        (fun p ->
          try Unix.unlink p with Unix.Unix_error (Unix.ENOENT, _, _) -> ())
        [ file; other ];
      Unix.rmdir root)
    (fun () ->
      Alcotest.(check bool)
        "missing is unconfigured" true
        (value (P.load ~root) = None);
      Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_excl ]
        0o600 file (fun channel ->
          output_string channel (config [ entry "pi" "work" "/profiles/work" ]));
      Alcotest.(check bool)
        "private registry loads" true
        (Option.is_some (value (P.load ~root)));
      Unix.chmod file 0o644;
      Alcotest.(check bool)
        "public registry refused" true
        (Result.is_error (P.load ~root));
      Unix.chmod file 0o600;
      Unix.rename file other;
      Unix.symlink other file;
      Alcotest.(check bool)
        "registry symlink refused" true
        (Result.is_error (P.load ~root));
      Unix.unlink file;
      Unix.link other file;
      Alcotest.(check bool)
        "registry hardlink refused" true
        (Result.is_error (P.load ~root));
      Alcotest.(check bool)
        "invalid root is a typed error" true
        (Result.is_error (P.validate_private_root "bad\000root")))

let shared_native_history () =
  let native kind id config_root role shared =
    replace "roots"
      (`Assoc [ ("config", s config_root); (role, s shared) ])
      (entry kind id "/unused")
  in
  List.iter
    (fun (kind, role) ->
      let shared = "/profiles/a/" ^ role in
      ignore
        (value
           (P.of_string
              (config
                 [
                   native kind "a" "/profiles/a" role shared;
                   native kind "b" "/profiles/b" role shared;
                 ]))))
    [ ("claude", "history"); ("pi", "history"); ("codex", "state") ];
  reject (config [ native "pi" "a" "/profiles/a" "history" "/profiles/a" ]);
  reject
    (config
       [ native "claude" "a" "/profiles/a/config" "history" "/profiles/a" ]);
  let a = entry "opencode-v2" "a" "/profiles/a" in
  let b =
    replace "roots"
      (`Assoc
         [
           ("config", s "/profiles/b/config");
           ("data", s "/profiles/a/data");
           ("state", s "/profiles/b/state");
           ("cache", s "/profiles/b/cache");
         ])
      (entry "opencode-v2" "b" "/unused")
  in
  reject (config [ a; b ])

let () =
  Alcotest.run "backend profiles"
    [
      ( "codec",
        [
          Alcotest.test_case "four backends" `Quick four_backends;
          Alcotest.test_case "label versus context identity" `Quick
            rename_identity;
          Alcotest.test_case "resolution refusals" `Quick resolve;
          Alcotest.test_case "public projection is not authority" `Quick
            public_projection;
          Alcotest.test_case "strict bounded schema" `Quick strict_schema;
          Alcotest.test_case "safe roots and aliases" `Quick paths;
          Alcotest.test_case "finite input" `Quick bounds;
          Alcotest.test_case "current root custody" `Quick filesystem_roots;
          Alcotest.test_case "private registry file custody" `Quick
            registry_file;
          Alcotest.test_case "shared native history is not shared auth" `Quick
            shared_native_history;
        ] );
    ]
