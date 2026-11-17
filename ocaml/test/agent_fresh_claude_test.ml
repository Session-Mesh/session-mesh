(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

let write path data perm =
  let oc = open_out_bin path in
  output_string oc data;
  close_out oc;
  Unix.chmod path perm

let sha text = Digestif.SHA256.(to_hex (digest_string text))

let test () =
  Eio_main.run (fun env ->
      Eio.Switch.run (fun _sw ->
          let dir = Test_scratch.private_directory "mesh-claude-start" in
          Fun.protect
            ~finally:(fun () ->
              List.iter
                (fun f -> Unix.unlink (Filename.concat dir f))
                [ "claude"; "catalog.json" ];
              Unix.rmdir dir)
            (fun () ->
              let executable = Filename.concat dir "claude" in
              let content = "#!/bin/sh\nexit 0\n" in
              write executable content 0o700;
              let environment =
                [
                  "HOME=" ^ dir;
                  "USER=owner";
                  "LOGNAME=owner";
                  "PATH=/usr/bin:/bin";
                  "SSH_AUTH_SOCK=/run/user/1000/agent.sock";
                ]
              in
              let catalog_json environment =
                `Assoc
                  [
                    ("version", `Int 2);
                    ( "launchers",
                      `Assoc
                        [
                          ( "claude",
                            `Assoc
                              [
                                ( "executable",
                                  `Assoc
                                    [
                                      ("path", `String executable);
                                      ("sha256", `String (sha content));
                                    ] );
                                ("entrypoint", `List []);
                                ( "environment",
                                  `List
                                    (List.map (fun s -> `String s) environment)
                                );
                              ] );
                        ] );
                    ("presets", `List []);
                    ("new_claude", `Assoc [ ("cwd", `String dir) ]);
                  ]
                |> Yojson.Basic.to_string
              in
              let json = catalog_json environment in
              let catalog = Filename.concat dir "catalog.json" in
              write catalog json 0o600;
              let loaded =
                Mesh_agent_resume_preset.load ~path:catalog
                  ~expected_sha256:(sha json)
                  ~hold_directory:(fun path -> Eio.Path.(env#fs / path))
                  ()
              in
              let id = "01234567-89ab-4def-8123-456789abcdef" in
              let entry =
                Option.get
                  (Mesh_agent_resume_preset.find loaded ("start-claude-" ^ id))
              in
              Alcotest.(check (list string))
                "only pinned launcher and session id"
                [ executable; "--session-id"; id ]
                (Mesh_agent_resume_preset.arguments entry);
              Alcotest.(check (array string))
                "explicit host metadata retained exactly"
                (Array.of_list environment)
                (Mesh_agent_resume_preset.environment entry);
              Alcotest.(check bool)
                "malformed id refused" true
                (Option.is_none
                   (Mesh_agent_resume_preset.find loaded
                      "start-claude-../../tmp"));
              let profile =
                Result.get_ok
                  (Mesh_resume_profile.new_claude ~conversation_id:id)
              in
              Alcotest.(check (list string))
                "exact resume profile" [ "--resume"; id ]
                (Mesh_resume_profile.arguments profile);
              Mesh_agent_resume_preset.revalidate entry;
              List.iter
                (fun invalid ->
                  let json = catalog_json invalid in
                  write catalog json 0o600;
                  let refused =
                    try
                      ignore
                        (Mesh_agent_resume_preset.load ~path:catalog
                           ~expected_sha256:(sha json)
                           ~hold_directory:(fun path ->
                             Eio.Path.(env#fs / path))
                           ());
                      false
                    with Invalid_argument _ -> true
                  in
                  Alcotest.(check bool)
                    "arbitrary or duplicate environment refused" true refused)
                [
                  environment @ [ "MESH_UNRELATED_SECRET=synthetic" ];
                  environment @ [ "SSH_AUTH_SOCK=/other/socket" ];
                ])))

let () =
  Alcotest.run "fresh Claude preset"
    [
      ( "catalog",
        [ Alcotest.test_case "pinned closed startup and resume" `Quick test ] );
    ]
