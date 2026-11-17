(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* The live Linux backend checks need procfs; the CLI checks run on Linux and
   macOS (the cases that need /dev/full or a Linux executable build only where
   those exist). *)
let live_suites =
  match Mesh_platform.platform with
  | Mesh_platform.Linux ->
      [ ("live linux backend", Test_live.tests); ("cli", Test_cli.tests) ]
  | Mesh_platform.Macos ->
      print_endline
        "skipped: the live linux backend suite (needs procfs; the live darwin \
         backend suite runs instead)";
      [ ("cli", Test_cli.tests) ]
  | Mesh_platform.Other name ->
      Printf.printf
        "skipped: the live backend and CLI suites (no backend for %s)\n%!" name;
      []

let () =
  Alcotest.run "mesh_platform"
    ([
       ("parse", Test_parse.tests);
       ("runtime_dir", Test_runtime_dir.tests);
       ("support", Test_support.tests);
       ("feature", Test_feature.tests);
       ("live darwin backend", Test_live_darwin.tests);
     ]
    @ live_suites)
