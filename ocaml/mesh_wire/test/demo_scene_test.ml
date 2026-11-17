(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

module S = Mesh_demo_scene

let scene ?(version = `Int 1) ?(title = `String "Démo")
    ?(theme = `String "dark") nodes =
  `Assoc
    [
      ("format", `String "mesh-scene-v0");
      ("version", version);
      ("title", title);
      ("theme", theme);
      ("nodes", `List nodes);
    ]

let check label expected document =
  Alcotest.(check bool)
    label true
    (S.validate_published ~expected_revision:1 (Yojson.Safe.to_string document)
    = expected)

let text value = `Assoc [ ("type", `String "text"); ("text", `String value) ]

let card children =
  `Assoc [ ("type", `String "card"); ("children", `List children) ]

let test_shared_vectors () =
  let check_file path =
    let raw = Yojson.Safe.from_file path in
    match raw with
    | `Assoc [ ("format", `Int 1); ("cases", `List cases) ] ->
        List.iter
          (function
            | `Assoc
                [
                  ("name", `String name);
                  ("accepted", `Bool accepted);
                  ("scene", scene);
                ] ->
                Alcotest.(check bool)
                  name accepted
                  (S.validate_published ~expected_revision:1
                     (Yojson.Safe.to_string scene)
                  = Ok ())
            | _ -> Alcotest.fail "invalid shared vector")
          cases
    | _ -> Alcotest.fail "invalid shared vector file"
  in
  check_file (Sys.getenv "MESH_SCENE_VECTORS");
  check_file (Sys.getenv "MESH_SCENE_V1_VECTORS");
  check_file (Sys.getenv "MESH_SCENE_V2_VECTORS")

let test_valid_and_version () =
  check "French title and text" (Ok ()) (scene [ text "Éléphant 🐘" ]);
  check "revision must match artifact" (Error S.Invalid)
    (scene ~version:(`Int 2) []);
  check "boolean is not a revision" (Error S.Invalid)
    (scene ~version:(`Bool true) []);
  check "unicode character limit, not byte limit" (Ok ())
    (scene
       ~title:(`String (String.concat "" (List.init 120 (fun _ -> "é"))))
       []);
  check "long unicode title" (Error S.Invalid)
    (scene
       ~title:(`String (String.concat "" (List.init 121 (fun _ -> "é"))))
       [])

let test_closed_fields_and_nodes () =
  let extra =
    match scene [] with
    | `Assoc entries -> `Assoc (("script", `String "alert(1)") :: entries)
    | _ -> assert false
  in
  check "unknown top-level field" (Error S.Invalid) extra;
  check "duplicate top-level field" (Error S.Invalid)
    (`Assoc
       [
         ("format", `String "mesh-scene-v0");
         ("format", `String "mesh-scene-v0");
         ("version", `Int 1);
         ("title", `String "Démo");
         ("theme", `String "dark");
         ("nodes", `List []);
       ]);
  check "node missing type" (Error S.Invalid)
    (scene [ `Assoc [ ("text", `String "x") ] ]);
  check "unknown node" (Error S.Invalid)
    (scene [ `Assoc [ ("type", `String "iframe") ] ]);
  check "extra node field" (Error S.Invalid)
    (scene
       [
         `Assoc
           [
             ("type", `String "text");
             ("text", `String "x");
             ("href", `String "https://example.invalid");
           ];
       ]);
  check "valid disclosure" (Ok ())
    (scene
       [
         `Assoc
           [
             ("type", `String "disclosure");
             ("summary", `String "Détails");
             ("children", `List [ text "Contenu" ]);
           ];
       ]);
  check "blank Unicode summary" (Error S.Invalid)
    (scene
       [
         `Assoc
           [
             ("type", `String "disclosure");
             ("summary", `String "\u{00A0}");
             ("children", `List []);
           ];
       ])

let test_bounds_and_encoding () =
  check "control character" (Error S.Invalid) (scene [ text "bad\rtext" ]);
  check "2000 characters" (Ok ()) (scene [ text (String.make 2000 'x') ]);
  check "2001 characters" (Error S.Invalid)
    (scene [ text (String.make 2001 'x') ]);
  let rec nested depth node =
    if depth = 0 then node else nested (depth - 1) (card [ node ])
  in
  check "depth 6" (Ok ()) (scene [ nested 6 (text "x") ]);
  check "depth 7" (Error S.Invalid) (scene [ nested 7 (text "x") ]);
  check "more than 100 nodes" (Error S.Invalid)
    (scene (List.init 26 (fun _ -> card (List.init 3 (fun _ -> text "x")))));
  Alcotest.(check bool)
    "invalid UTF-8 refused" true
    (S.validate_published ~expected_revision:1
       "{\"format\":\"mesh-scene-v0\",\"version\":1,\"title\":\"\xff\",\"theme\":\"dark\",\"nodes\":[]}"
    = Error S.Malformed);
  Alcotest.(check bool)
    "oversized bytes refused before parsing" true
    (S.validate_published ~expected_revision:1
       (String.make ((64 * 1024) + 1) 'x')
    = Error S.Too_large)

let () =
  Alcotest.run "demo scene admission"
    [
      ( "closed scene",
        [
          Alcotest.test_case "shared Python and OCaml vectors" `Quick
            test_shared_vectors;
          Alcotest.test_case "valid content and version" `Quick
            test_valid_and_version;
          Alcotest.test_case "closed fields and nodes" `Quick
            test_closed_fields_and_nodes;
          Alcotest.test_case "bounds and encoding" `Quick
            test_bounds_and_encoding;
        ] );
    ]
